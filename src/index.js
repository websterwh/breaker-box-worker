const FIFTEEN_MIN_MS = 15 * 60 * 1000;

// Synthetic cache key - Cache API is free with no per-op quota (unlike KV)
// and, unlike a plain in-memory variable, survives the Worker isolate being
// recycled between requests. Used only for the "how long has this been
// down" display timer.
const CACHE_KEY = new Request("https://internal.invalid/breaker-box-down-since");

// Reserved path prefix for the built-in CORS relay to api.cloudflare.com
// (see relayToCloudflareApi below). Real site traffic through this Worker
// is never expected to use this prefix; if it somehow does, that request
// would have been relayed to Cloudflare's API instead of your origin, so
// keep this specific enough that it can't collide with a real route.
const RELAY_PREFIX = "/__bbproxy";

const DEFAULT_MESSAGES = {
    MAINT_TITLE: "Under maintenance",
    MAINT_BODY: "This server is offline for scheduled maintenance. It'll be back online shortly.",
    RESTART_TITLE: "Restarting",
    RESTART_BODY: "This server is restarting for a moment. It'll be back online shortly.",
    OFFLINE_TITLE: "Device is offline",
    OFFLINE_BODY: "This server has been unreachable for a while. Please contact the owner.",
    FOOTNOTE: "",
};

// Every value here is optional. Set it as a Worker secret or variable
// (Cloudflare dashboard -> this Worker -> Settings -> Variables and
// Secrets), or from the Breaker Box plugin's Messages settings, which
// writes to the same names through this Worker's built-in relay. Unset
// falls back to the text above.
function messages(env) {
    const out = {};
    for (const key of Object.keys(DEFAULT_MESSAGES)) {
        out[key] = env[key] || DEFAULT_MESSAGES[key];
    }
    return out;
}

// --- Self-management: this Worker can clear its own MODE / MODE_REVERT_AT
// secrets via the Cloudflare API. Requires three things bound on this
// Worker itself (separate from anything the Breaker Box plugin sends):
//   - CF_API_TOKEN   (secret) - needs "Edit Cloudflare Workers" permission
//   - CF_ACCOUNT_ID  (secret or plain var) - your Cloudflare account ID
//   - CF_SCRIPT_NAME (plain var, optional) - defaults to this script's name
// If these aren't set, the timer and auto-revert features just silently
// don't do anything - the manual M/R/off override behavior still works
// exactly as before.
async function deleteSecret(env, name) {
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return;
    const scriptName = env.CF_SCRIPT_NAME || "breaker-box-worker";
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${scriptName}/secrets/${name}`;
    try {
        // A 404/"not found" here just means it's already cleared - fine either way.
        await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        });
    } catch (e) {
        // Network hiccup calling Cloudflare's own API - not fatal. Worst case,
        // the next request or the next scheduled tick tries again.
    }
}

async function clearModeAndTimer(env) {
    await Promise.all([deleteSecret(env, "MODE"), deleteSecret(env, "MODE_REVERT_AT")]);
}

function timerExpired(env) {
    if (!env.MODE || !env.MODE_REVERT_AT) return false;
    const revertAt = parseInt(env.MODE_REVERT_AT, 10);
    return !isNaN(revertAt) && Date.now() >= revertAt;
}

// Generic CORS-unlocking relay to api.cloudflare.com, mounted at
// RELAY_PREFIX. Browsers can't call api.cloudflare.com directly - it
// doesn't send Access-Control-Allow-Origin headers, so the browser blocks
// the request before it reaches Cloudflare. The Breaker Box plugin talks
// to this instead: it forwards whatever the caller sends (method, path,
// headers, body) to api.cloudflare.com untouched, then adds CORS headers
// to the response so the browser accepts it.
//
// This relay holds no secrets of its own. The caller supplies their own
// Cloudflare API token with every request; this Worker only relays it
// upstream and never stores or logs it. Only requests to
// api.cloudflare.com are ever forwarded - it cannot reach any other host.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Auth-Email,X-Auth-Key",
    "Access-Control-Max-Age": "86400",
};

async function relayToCloudflareApi(request, url) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const upstreamPath = url.pathname.slice(RELAY_PREFIX.length) || "/";
    if (upstreamPath === "/" && request.method === "GET") {
        return new Response(
            JSON.stringify({ ok: true, proxying: "https://api.cloudflare.com" }),
            { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
    }

    const upstreamUrl = "https://api.cloudflare.com" + upstreamPath + url.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");

    const init = {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : await request.arrayBuffer(),
    };

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(upstreamUrl, init);
    } catch (err) {
        return new Response(
            JSON.stringify({ success: false, errors: [{ message: `Relay fetch failed: ${err.message}` }] }),
            { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(k, v);
    }
    responseHeaders.delete("set-cookie");

    return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(RELAY_PREFIX + "/")) {
            return relayToCloudflareApi(request, url);
        }

        // Timer safety net: if a revert-at time has passed, clear MODE (and the
        // timer secret) and fall straight through to normal auto-detect for
        // this request - don't make the visitor wait an extra round trip.
        if (timerExpired(env)) {
            ctx.waitUntil(clearModeAndTimer(env));
            return autoDetect(request, env, ctx);
        }

        const mode = env.MODE; // "M" | "R" | undefined
        const msg = messages(env);

        // Manual maintenance override - always instant, never escalates, never
        // auto-clears based on origin health (only the timer above can end it).
        if (mode === "M") {
            ctx.waitUntil(caches.default.delete(CACHE_KEY));
            return page(shell(msg.FOOTNOTE, `
                <div class="spinner" aria-hidden="true"></div>
                <h1>${escapeHtml(msg.MAINT_TITLE)}</h1>
                <p>${escapeHtml(msg.MAINT_BODY)}</p>
            `));
        }

        // Manual "rebooting" override - always shown to THIS visitor, exactly
        // like M. Origin health is checked in the background (not blocking or
        // altering this response) so a future request can auto-clear MODE once
        // the origin is confirmed healthy again - the override never flickers
        // off mid-restart just because one request happened to still get a
        // response.
        if (mode === "R") {
            ctx.waitUntil(checkOriginAndMaybeClear(request, env));
            return page(await rebootingOrOfflineHtml(caches.default, ctx, msg));
        }

        return autoDetect(request, env, ctx, msg);
    },

    // Cron-triggered: enforces the timer even with zero incoming traffic.
    // Add a Cron Trigger to this Worker (Cloudflare dashboard -> this Worker
    // -> Triggers -> Cron Triggers) for this to run on a schedule, e.g. every
    // minute: */1 * * * *
    async scheduled(event, env, ctx) {
        if (timerExpired(env)) {
            ctx.waitUntil(clearModeAndTimer(env));
        }
    },
};

async function checkOriginAndMaybeClear(request, env) {
    try {
        const resp = await fetch(request.clone ? request.clone() : request);
        if (resp.status < 500) {
            await clearModeAndTimer(env);
        }
    } catch (e) {
        // Still down - leave MODE set, try again on the next request.
    }
}

async function autoDetect(request, env, ctx, msg) {
    try {
        const resp = await fetch(request);
        if (resp.status >= 500) throw new Error("origin error " + resp.status);
        ctx.waitUntil(caches.default.delete(CACHE_KEY));
        return resp;
    } catch (e) {
        return page(await rebootingOrOfflineHtml(caches.default, ctx, msg || messages(env)));
    }
}

async function rebootingOrOfflineHtml(cache, ctx, msg) {
    let downSince;
    const cached = await cache.match(CACHE_KEY);

    if (cached) {
        downSince = parseInt(await cached.text(), 10);
    } else {
        downSince = Date.now();
        const entry = new Response(String(downSince), {
            headers: { "Cache-Control": "max-age=86400" },
        });
        ctx.waitUntil(cache.put(CACHE_KEY, entry));
    }

    const elapsed = Date.now() - downSince;
    if (elapsed >= FIFTEEN_MIN_MS) {
        return shell(msg.FOOTNOTE, `
            <div class="dot" aria-hidden="true">!</div>
            <h1>${escapeHtml(msg.OFFLINE_TITLE)}</h1>
            <p>${escapeHtml(msg.OFFLINE_BODY)}</p>
        `);
    }
    return shell(msg.FOOTNOTE, `
        <div class="spinner" aria-hidden="true"></div>
        <h1>${escapeHtml(msg.RESTART_TITLE)}</h1>
        <p>${escapeHtml(msg.RESTART_BODY)}</p>
    `);
}

function page(html) {
    return new Response(html, {
        status: 503,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "retry-after": "300",
            "cache-control": "no-store",
        },
    });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
}

function shell(footnote, bodyContent) {
    const footnoteHtml = footnote ? `<div class="footnote">${escapeHtml(footnote)}</div>` : "";
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Be right back</title>
    <style>
    :root {
        color-scheme: light dark;
        --bg: #f5f5f7;
        --fg: #111114;
        --muted: #6b6b73;
        --accent: #f97316;
        --card-bg: #ffffff;
        --card-border: rgba(0,0,0,0.08);
        --shadow: rgba(0,0,0,0.08);
    }

    @media (prefers-color-scheme: dark) {
        :root {
            --bg: #0b0b0d;
            --fg: #f2f2f4;
            --muted: #9a9aa2;
            --accent: #fb923c;
            --card-bg: #17171b;
            --card-border: rgba(255,255,255,0.08);
            --shadow: rgba(0,0,0,0.4);
        }
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }

    body {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        background: var(--bg);
        color: var(--fg);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        padding: 24px;
        text-align: center;
    }

    .card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 20px;
        box-shadow: 0 10px 40px var(--shadow);
        padding: 48px 40px;
        max-width: 420px;
        width: 100%;
    }

    .spinner {
        width: 44px;
        height: 44px;
        margin: 0 auto 24px;
        border-radius: 50%;
        border: 3px solid var(--card-border);
        border-top-color: var(--accent);
        animation: spin 0.9s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .dot {
        width: 44px;
        height: 44px;
        margin: 0 auto 24px;
        border-radius: 50%;
        background: var(--accent);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        font-weight: 700;
    }

    h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 15px; line-height: 1.5; color: var(--muted); margin: 0; }

    .footnote {
        margin-top: 20px;
        font-size: 12px;
        color: var(--muted);
        opacity: 0.7;
    }
    </style>
    </head>
    <body>
    <div class="card">
    ${bodyContent}
    ${footnoteHtml}
    </div>
    </body>
    </html>`;
}
