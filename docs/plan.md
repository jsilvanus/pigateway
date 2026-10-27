# pigateway plan (2026-10-27)

pigateway is the one process on the Pi that holds the connections to the devices: ATEM, cameras (VISCA over UDP and the CGI), the AMX master (TCP), later the tally light (stream-light) and the encoder. It owns device state and publishes it as events. It does no video work; ffmpeg, MediaMTX, HDMI out, effects and composites stay in pimatrix. YouTube is not here; that is pitube.

## Rules

- Small and boring: Node 24 ESM, Fastify, systemd restart, watchdogs on every socket, no database.
- Same endpoints as pimatrix has today (`/api/v1/atem/*`, `/api/v1/cameras/*`, `/api/v1/events`), so picontrol, the CLI and the MCP only change their base URL.
- Env prefix `PIGATEWAY_`. Writes need `PIGATEWAY_API_KEY` unless the client is on `PIGATEWAY_AUTH_ALLOWED_HOSTS`.
- FreeD: the gateway owns the on/off and target setting; packets go straight from the camera to the consumer.
- No deploy and no live device contact from this repo's threads while Pi work is on hold.

## Phases

1. **Scaffold, ATEM, cameras** (this PR): config, auth, CORS, SSE events, `/health`, `/api/v1/status`, ATEM adapter and routes, camera service and routes, ported with their tests.
2. **AMX**: outbound client to the master (Atlona route and status, port 6501) and the TCP listener on 6600 (`PiMatrix_Bridge.axi`). Camera commands go to the camera service; video commands (SOURCE, OUTPUT, QUICK, PROGRAM) are forwarded to pimatrix over HTTP.
3. **pimatrix switch-over**: pimatrix drops its ATEM, camera and AMX code and calls pigateway (`PIMATRIX_GATEWAY_URL`) for what it still needs (composites use the ATEM media player and DSK). Camera RTMP push URLs stay configurable here.
4. **OpenAPI and CLI**: `openapi/openapi.yaml`, generated client and CLI like the other Pi services.
5. **Tally**: stream-light as an in-process source fed by the ATEM state, with outputs to the tally lamps.
6. **Deploy** (later, with Juha): systemd user unit on kirkonpi, picontrol and picontrol-mcp pointed at the gateway, AMX master target updated.

## Open points

- Whether pimatrix keeps proxying `/api/v1/atem` and `/api/v1/cameras` for a transition period (proposal: yes, one release).
- Port: 3100 by default; pimatrix keeps 3000.
