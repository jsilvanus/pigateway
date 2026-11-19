# picontrol UI listeners

Two optional HTTP listeners let the picontrol web UI reach the gateway without the full API. Each serves only an
allowlist of module routes (`src/ui/ui-listener.ts`, `UI_ROUTES`); everything else answers 404.

| Listener | Env | Bind | Role |
|---|---|---|---|
| LAN | `PIGATEWAY_UI_PORT` (e.g. 3011) | `0.0.0.0` | `lan`: operate routes and setup routes |
| Relay | `PIGATEWAY_UI_RELAY_PORT` (e.g. 3012) | `127.0.0.1` | `relay`: operate routes only, reached through an ssh tunnel from a public relay |

- `PIGATEWAY_UI_PIN` (at least 6 characters, required when either listener is on) opens both. `POST /ui/api/login` `{pin}` sets an HttpOnly, SameSite=Strict session cookie. A session lasts 24 h from the last request (every request extends it, server side and in the cookie); idle for 24 h means the PIN is asked again, as does `POST /ui/api/logout` (the UI's lock button) or a gateway restart. A wrong PIN waits 600 ms. There is no PIN-free mode: `PIGATEWAY_UI_LAN_NO_PIN` is gone and the gateway refuses to start a UI listener without `PIGATEWAY_UI_PIN`.
- `PIGATEWAY_UI_LAN_TRUSTED_IPS` (comma list of IPv4 addresses, unset = nobody) lets those hosts, such as the operator PC, use the **LAN listener** without the PIN. Never the relay. The address is the socket peer; `X-Forwarded-For` is never read. When the Pi's nginx sits in front (the peer is loopback), `X-Real-IP` is used, so nginx must set `proxy_set_header X-Real-IP $remote_addr;` for the `/api/` and `/ui/api/` locations (it overwrites a client-sent value). Keep the real address in the Pi env, not in the repo.
- The role comes from the listener socket, never from a header, so `X-Forwarded-For` and similar headers are ignored.
- `PIGATEWAY_UI_CORS_ORIGINS`: the picontrol UI origin(s) allowed to call with credentials. Other origins get no CORS headers.
- Modules: `matrix` (Atlona routes, lock), `pivoice` (session start/stop, idle-close), `piencoder` (list, start, stop), `pitube` (status, current broadcast, start, stop, stop request). pitube is an upstream: `PIGATEWAY_PITUBE_API_URL` and optional `PIGATEWAY_PITUBE_API_TOKEN`. Only the origin of that URL is used.
- Gateway routes run in-process through `app.inject`; the gateway's `PIGATEWAY_API_KEY` is added server side and never sent to the browser.
- `GET /api/v1/events` (live events, SSE) is streamed on both listeners, session required. The type list is fixed on the server (`UI_EVENT_TYPES`: camera, matrix, encoder, atem, youtube, pivoice, pivoice-activity, pisound, ecosystem); a `types` query from the client is ignored, so transcripts, rundown, world state, perception and tracking never leave through the UI listeners. Behind nginx or Traefik the stream needs buffering off (`X-Accel-Buffering: no` is sent).
- Not exposed on any UI listener: pitube ingest/RTMP settings, device configuration, Canva, transcripts, rundown. Camera and ATEM (`video-mixer`) operating routes are served on the LAN listener only (`lanOnly`); the relay answers 403.
- Setup routes (`setup: true` in the table) answer on the LAN listener only.
- Auth is pluggable (`UiAuthAdapter`). The PIN adapter is the first; an OIDC adapter can replace it later without changing the routes.
- Verified by unit tests only (`tests/ui-listener.test.ts`); not run against the Pi devices.

## Module filter

`PIGATEWAY_UI_MODULES` (comma list: `matrix,pivoice,piencoder,pitube`; unset = all) limits both listeners to those modules. Routes of other modules answer 404. Use the same names as picontrol's `VITE_PICONTROL_MODULES`; names with no gateway route (such as `outputs`) are ignored.

## piprogram on the relay

Adding content works from outside the church network, behind the PIN: items (hymn, YouTube, media, PPTX, Canva), `use-at`, prepare, playlist order, save, generate and replace. Only deleting items and playlists, feed config, audio arm and play, text to speech and the basic image stay LAN only. The UI listeners accept bodies up to 60 MB for uploads, but a request without a session may not carry more than 256 KB.
