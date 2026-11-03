# Canva-only listener (for a tunnel)

A second HTTP listener that serves only `/api/v1/canva/*`, so a public reverse proxy can reach the Canva plugin's routes through an ssh tunnel without exposing ATEM, camera or AMX control.

- Off unless `PIGATEWAY_CANVA_TUNNEL_PORT` is set (port map: `3010`). Binds `127.0.0.1` only.
- `PIGATEWAY_API_KEY` is required on every request, reads included. The allowed-hosts list and `X-Forwarded-For` are ignored (through a tunnel every caller is 127.0.0.1). Without a key the listener answers 503.
- `PIGATEWAY_CANVA_TUNNEL_CORS_ORIGINS`: comma-separated browser origins (the Canva app's origin). Other origins get no CORS headers; preflights from them get 403.
- Shares the Canva service and routes with the main port, so tasks started through either are visible on both.
- Every other path is a 404 (401 without the key).

The reverse proxy strips its public prefix (for example `/canva`) and forwards to the tunnel end that points at this port. The VPS and Pi side of the setup is documented with the church setup, not here.
