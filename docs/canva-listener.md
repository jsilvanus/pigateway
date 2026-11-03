# Canva-only listener (for a tunnel)

A second HTTP listener that serves only `/api/v1/canva/*`, so a public reverse proxy can reach the Canva plugin's routes through an ssh tunnel without exposing ATEM, camera or AMX control.

- Off unless `PIGATEWAY_CANVA_TUNNEL_PORT` is set (port map: `3010`). Binds `127.0.0.1` only.
- Every request needs one of two credentials, reads included. The allowed-hosts list and `X-Forwarded-For` are ignored (through a tunnel every caller is 127.0.0.1).
  - `PIGATEWAY_API_KEY`: the shared key, sent as `Authorization: Bearer` or `X-Api-Key`.
  - A Canva user token (a JWT, from the plugin's `auth.getCanvaUserToken()`), when `PIGATEWAY_CANVA_APP_ID` and `PIGATEWAY_CANVA_ALLOWED_BRANDS` are set. The gateway checks it against Canva's JWKS for the app (RS256, audience = app id, `brandId` = the team). A token from a team not on the list gets 403; a bad or expired token gets 401. This is the team scope: no key is shipped in the plugin bundle.
  - With neither configured the listener answers 503.
  - Dependency: `@canva/app-middleware` (pinned to 0.0.0-beta.8; the same JWKS check Canva's own samples use).
- `PIGATEWAY_CANVA_TUNNEL_CORS_ORIGINS`: comma-separated browser origins (the Canva app's origin). Other origins get no CORS headers; preflights from them get 403.
- Shares the Canva service and routes with the main port, so tasks started through either are visible on both.
- Every other path is a 404 (401 without the key).

The reverse proxy strips its public prefix (for example `/canva`) and forwards to the tunnel end that points at this port. The VPS and Pi side of the setup is documented with the church setup, not here.
