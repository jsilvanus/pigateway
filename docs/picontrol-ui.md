# picontrol UI listeners

Two optional HTTP listeners let the picontrol web UI reach the gateway without the full API. Each serves only an
allowlist of module routes (`src/ui/ui-listener.ts`, `UI_ROUTES`); everything else answers 404.

| Listener | Env | Bind | Role |
|---|---|---|---|
| LAN | `PIGATEWAY_UI_PORT` (e.g. 3011) | `0.0.0.0` | `lan`: operate routes and setup routes |
| Relay | `PIGATEWAY_UI_RELAY_PORT` (e.g. 3012) | `127.0.0.1` | `relay`: operate routes only, reached through an ssh tunnel from a public relay |

- `PIGATEWAY_UI_PIN` (at least 6 characters, required when either listener is on) opens both. `POST /ui/api/login` `{pin}` sets an HttpOnly, SameSite=Strict session cookie for 12 h. A wrong PIN waits 600 ms.
- The role comes from the listener socket, never from a header, so `X-Forwarded-For` and similar headers are ignored.
- `PIGATEWAY_UI_CORS_ORIGINS`: the picontrol UI origin(s) allowed to call with credentials. Other origins get no CORS headers.
- Modules: `matrix` (Atlona routes, lock), `pivoice` (session start/stop, idle-close), `piencoder` (list, start, stop), `pitube` (status, current broadcast, start, stop, stop request). pitube is an upstream: `PIGATEWAY_PITUBE_API_URL` and optional `PIGATEWAY_PITUBE_API_TOKEN`. Only the origin of that URL is used.
- Gateway routes run in-process through `app.inject`; the gateway's `PIGATEWAY_API_KEY` is added server side and never sent to the browser.
- Not exposed on any UI listener: pitube ingest/RTMP settings, device configuration, Canva, transcripts, cameras, rundown.
- Setup routes (`setup: true` in the table) answer on the LAN listener only.
- Auth is pluggable (`UiAuthAdapter`). The PIN adapter is the first; an OIDC adapter can replace it later without changing the routes.
- Verified by unit tests only (`tests/ui-listener.test.ts`); not run against the Pi devices.
