# breaker-box-worker

One Worker, two jobs:

1. **Front your origin.** On every request it either passes the request
   through untouched, or shows a maintenance / restarting / offline page
   instead — controlled by a `MODE` secret that the Breaker Box plugin
   flips for you.
2. **Relay the Cloudflare API for the plugin**, mounted at `/__bbproxy/*`.
   Browsers can't call `api.cloudflare.com` directly — it doesn't send
   `Access-Control-Allow-Origin` headers, so the browser blocks the
   request before it reaches Cloudflare. The plugin calls this Worker's
   own `/__bbproxy/...` path instead, which forwards the request
   server-side (no CORS problem there) and adds CORS headers to the
   response. It holds no secrets of its own — the plugin sends its own
   Cloudflare API token with every request, and this Worker only relays
   it upstream, never stores or logs it, and only ever forwards to
   `api.cloudflare.com`.

## `MODE` behavior

- `MODE` unset — passes requests straight through. If the origin returns
  a 5xx or the request fails, it shows a "Restarting" page for the first
  15 minutes of an outage, then an "Offline" page after that.
- `MODE=M` — always shows the "Under maintenance" page, regardless of
  origin health.
- `MODE=R` — always shows the "Restarting" page to this visitor, while
  checking the origin in the background so `MODE` clears itself once the
  origin is healthy again.

## Deploy your own copy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/websterwh/breaker-box/tree/main/worker)

After deploying, point this Worker at your real origin (Route or Custom
Domain, in the Cloudflare dashboard) and note its script name and its
`*.workers.dev` (or custom) URL — you'll enter both in the Breaker Box
plugin's settings.

## Customizing the messages

Every message is optional and falls back to a plain default if unset. Set
any of these as a Worker secret or variable (dashboard → this Worker →
Settings → Variables and Secrets), or from the Breaker Box plugin's
Messages panel, which writes to the same names through this Worker's
built-in relay:

| Name            | Shown when             | Default                                                              |
|-----------------|-------------------------|-----------------------------------------------------------------------|
| `MAINT_TITLE`   | `MODE=M`                | Under maintenance                                                      |
| `MAINT_BODY`    | `MODE=M`                | This server is offline for scheduled maintenance. It'll be back online shortly. |
| `RESTART_TITLE` | `MODE=R` or auto-detect | Restarting                                                             |
| `RESTART_BODY`  | `MODE=R` or auto-detect | This server is restarting for a moment. It'll be back online shortly.  |
| `OFFLINE_TITLE` | down > 15 min           | Device is offline                                                      |
| `OFFLINE_BODY`  | down > 15 min           | This server has been unreachable for a while. Please contact the owner. |
| `FOOTNOTE`      | every page above        | (none)                                                                 |

## Updating this Worker's code from the plugin

The plugin's Settings panel has an "Update Worker Code" action that
pushes the latest bundled copy of this file to your deployed Worker, so
you don't have to manually copy/paste code into the dashboard every time
the plugin updates. Before overwriting the script, it reads back your
current bindings (secrets, vars) and re-submits them unchanged alongside
the new code — existing secrets are not expected to be affected, but
confirm with "Refresh status" afterward the first time you use it.

## Optional: self-clearing timer

To let a "Restarting" or timed "Under maintenance" state clear itself
automatically, set these on this Worker (separate from anything the
plugin sends):

- `CF_API_TOKEN` (secret) — needs "Edit Cloudflare Workers" permission
- `CF_ACCOUNT_ID` — your Cloudflare account ID
- `CF_SCRIPT_NAME` — this Worker's script name (defaults to `breaker-box-worker`)

Without these, the timer/auto-revert features are silent no-ops — manual
`M` / `R` / off still work exactly the same. Add a Cron Trigger (dashboard
→ this Worker → Triggers) so the timer is also enforced with zero
incoming traffic, e.g. every minute: `*/1 * * * *`.
