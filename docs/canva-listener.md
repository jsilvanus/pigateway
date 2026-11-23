# Canva-only listener (for a tunnel)

A second HTTP listener that serves only `/api/v1/canva/*`, so a public reverse proxy can reach the Canva plugin's routes through an ssh tunnel without exposing ATEM, camera or AMX control.

- Off unless `PIGATEWAY_CANVA_TUNNEL_PORT` is set (port map: `3010`). Binds `127.0.0.1` only.
- Every request needs one of two credentials, reads included. The allowed-hosts list and `X-Forwarded-For` are ignored (through a tunnel every caller is 127.0.0.1).
  - `PIGATEWAY_API_KEY`: the shared key, sent as `Authorization: Bearer` or `X-Api-Key`.
  - A Canva user token (a JWT, from the plugin's `auth.getCanvaUserToken()`), when `PIGATEWAY_CANVA_APP_ID` and `PIGATEWAY_CANVA_ALLOWED_BRANDS` are set. The gateway checks it against Canva's JWKS for the app (RS256, audience = app id, `brandId` = the team). A token from a team not on the list gets 403; a bad or expired token gets 401. This is the team scope: no key is shipped in the plugin bundle.
  - A Tunnus sign-in token (an RS256 access token from the parish's Tunnus), when `PIGATEWAY_CANVA_OIDC=true`. See "Tunnus sign-in" below.
  - With nothing configured the listener answers 503.
  - Dependency: `@canva/app-middleware` (pinned to 0.0.0-beta.8; the same JWKS check Canva's own samples use).
- `PIGATEWAY_CANVA_TUNNEL_CORS_ORIGINS`: comma-separated browser origins (the Canva app's origin). Other origins get no CORS headers; preflights from them get 403.
- Shares the Canva service and routes with the main port, so tasks started through either are visible on both.
- Every other path is a 404 (401 without the key).

The reverse proxy strips its public prefix (for example `/canva`) and forwards to the tunnel end that points at this port. The VPS and Pi side of the setup is documented with the church setup, not here.

## Go live: action lists

After a Canva export is ready the plugin offers play options (feed, Pi output, left or right projector, fade to black) and a Go live button. The button saves an **action list** and gets back a link; it never runs the list itself.

- `POST /api/v1/canva/action-lists` `{ name, steps: [{ action, params }], singleUse?, ttlSeconds? }` on this listener makes the list (201, with `id`, `state`, `runPath` and, when `PIGATEWAY_PICONTROL_URL` is set, `link`). Only these steps are accepted, with params checked and unknown keys dropped; anything else (cameras, encoders, the ATEM, setup) is 422:
  - `pipgm:playlist-set {feed, itemIds, name?}` replaces the feed's playlist atomically (and saves it under `name`),
  - `pipgm:route {feed, output: pi1|pi2}` sends the feed to the Pi's HDMI output (through pimatrix),
  - `matrix:route {input: 3|4, output: 1|2}` sends a Pi input to a projector (left = 1, right = 2),
  - `pipgm:ftb {feed, on}` and `pipgm:control {feed, action, stepIndex?, itemIndex?, itemId?, entryId?}` (for example `gotoItem`).
- `GET /api/v1/canva/action-lists/:id` reads it. There is no run, list or delete here.
- Defaults: single use, valid 15 minutes (`ttlSeconds` 30 to 86400). A failing step stops the run; a failed run does not use the list up, so the link can retry.
- **Running** is picontrol's job: the link opens `/run/<id>` there, which reads the list and runs it with `POST /api/v1/action-lists/:id/run` on the LAN UI listener. The internet relay can read lists and run those without a matrix step; a list that routes a projector answers 403 `PROJECTOR_NOT_ON_RELAY` there.
- The same lists are on the main API (`/api/v1/action-lists`, any registered action, create, list, get, delete, run) and use the actions `pipgm:playlist-set`, `pipgm:ftb`, `pipgm:control` and `pipgm:route` that are also in `GET /api/v1/actions`.
- `PIGATEWAY_ACTION_LIST_DIR` keeps lists as `<id>.json` across restarts (unset = memory only), `PIGATEWAY_PICONTROL_URL` is the base for the link. Not verified on the Pi.

## Tunnus sign-in (off by default)

Lets people sign in with the parish's Tunnus instead of a shared key. Verified by a shared verifier (`src/auth/tunnus.ts`, no extra dependency): RS256 signature from the issuer's JWKS (discovery, cached ten minutes, refetched once on an unknown `kid`, optionally kept in a file so a restart without internet still works), `iss` equal to the issuer, `exp`/`nbf` with 30 s leeway and `aud` (string or array) **containing the gateway's name**. Rights come only from the `groups` claim.

| Variable | Meaning |
|---|---|
| `PIGATEWAY_CANVA_OIDC` | `true` turns it on (default off). Needs the two below. |
| `PIGATEWAY_OIDC_ISSUER` | Tunnus issuer URL |
| `PIGATEWAY_OIDC_GROUP_RIGHTS` | `<group>=<module>:<level>[,...];<group>=@preset...`. Presets: `@viewer`, `@operator`, `@content`, `@admin`. Unlisted groups give nothing; several groups give the union. |
| `PIGATEWAY_OIDC_AUDIENCE` | The name tokens must carry in `aud` (default `pigateway`) |
| `PIGATEWAY_OIDC_JWKS_CACHE_FILE` | Optional file for the last good key set |
| `PIGATEWAY_CANVA_TUNNEL_API_KEY_FALLBACK` | `false` stops the shared key opening this listener (default `true`) |

Rights on this listener are the module `canva` (explicit; `*` and `piprogram:*` never imply it):

- `canva:read`: `GET` status, task, saved action list, session. Any other canva level includes it.
- `canva:write`: `POST /push` (send slides), `POST /action-lists` when every step is `pipgm:playlist-set` (save playlists).
- `canva:operate`: `POST /setup` and `POST /control` (cue, presentation controls, projector routing and picture mute), and `POST /action-lists` when a list has any other step (Go live).
- `canva:admin` includes all of them.

A route with no rule is refused (403). Cameras and the rest of the gateway are not on this listener at all. A token that is valid but whose groups give no canva right gets 403 `NO_ACCESS`; a bad, expired or wrong-audience token gets 401; if no key set can be fetched and none is cached, 503.

`GET /api/v1/canva/session` returns `{ auth, name, rights }` (for example `["canva:read","canva:write"]`) so the plugin can hide what the person may not do. Key and Canva-user-token callers get every canva right, as before.

Unverified against a real Tunnus; the tests use a fake issuer.
