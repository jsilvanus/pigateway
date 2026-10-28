# pigateway plan (2026-10-27)

pigateway is the one process on the Pi that holds the connections to the devices: ATEM, cameras (VISCA over UDP and the CGI), the AMX master (TCP), the Matrox Monarch HDX encoder (through `@jsilvanus/matrox-monarch-control`: state, start/stop, settings, RTMP target; one command at a time, busy answers retried) and, later, the tally light (stream-light). It owns device state and publishes it as events. It does no video work; ffmpeg, MediaMTX, HDMI out, effects and composites stay in pimatrix. YouTube is not here; that is pitube.

## Rules

- Small and boring: Node 24 ESM, Fastify, systemd restart, watchdogs on every socket, no database.
- Same endpoints as pimatrix has today (`/api/v1/atem/*`, `/api/v1/cameras/*`, `/api/v1/events`), so picontrol, the CLI and the MCP only change their base URL.
- Env prefix `PIGATEWAY_`. Writes need `PIGATEWAY_API_KEY` unless the client is on `PIGATEWAY_AUTH_ALLOWED_HOSTS`.
- FreeD: the gateway owns the on/off and target setting; packets go straight from the camera to the consumer.
- No deploy and no live device contact from this repo's threads while Pi work is on hold.

## PiVoice activity-session coordination (implemented; integration verification pending)

PiGateway also owns the lifecycle for activity-triggered Auditor sessions. PiVoice remains the audio owner and sends pre-roll directly to Auditor; audio bytes must never transit this gateway.

- Receive PiVoice's existing binary UDP telemetry and use its speech/music classification.
- Select triggers using `PIGATEWAY_PIVOICE_START_WHEN=speech|speech_or_music` (default `speech_or_music`).
- Call PiVoice's authenticated control API using `PIGATEWAY_PIVOICE_API_URL` and `PIGATEWAY_PIVOICE_API_TOKEN`.
- Own the idle-close timer through `PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS` (default 15; zero disables automatic close).
- Publish coordinator state in `GET /api/v1/status` and the `pivoice-activity` SSE event.
- Expose the timeout at `GET/PUT /api/v1/activity/idle-close`; keep the OpenAPI specification and runtime-generated CLI in sync.
- Do not deploy or contact live devices as part of implementation.

**Acceptance checks:** build and tests pass; a simulated speech/music → open → silence → close cycle works; repeated activity resets the timer; zero disables auto-close; shutdown stops an open session; a PiVoice/Auditor failure is visible in coordinator state. Real hardware and church-audio validation remain separate.

## Phases

1. **Scaffold, ATEM, cameras** (done): config, auth, CORS, SSE events, `/health`, `/api/v1/status`, ATEM adapter and routes, camera service and routes, ported with their tests.
2. **AMX** (done): outbound client to the master (Atlona route and status, port 6501) and the TCP listener on 6600 (`PiMatrix_Bridge.axi`). Camera commands go to the camera service; video commands (SOURCE, OUTPUT, QUICK, PROGRAM) are forwarded to pimatrix over HTTP.
3. **pimatrix switch-over** (done; pimatrix passes `/api/v1/atem*`, `/cameras*` and `/matrix*` on and relays events): pimatrix drops its ATEM, camera and AMX code and calls pigateway (`PIMATRIX_GATEWAY_URL`) for what it still needs (composites use the ATEM media player and DSK). Camera RTMP push URLs stay configurable here.
4. **OpenAPI and CLI** (done; `openapi/openapi.json`, run-time CLI): `openapi/openapi.yaml`, generated client and CLI like the other Pi services.
5. **Tally**: stream-light as an in-process source fed by the ATEM state, with outputs to the tally lamps.
6. **Deploy** (later, with Juha): systemd user unit on kirkonpi, picontrol and picontrol-mcp pointed at the gateway, AMX master target updated.

## Open points

- Whether pimatrix keeps proxying `/api/v1/atem` and `/api/v1/cameras` for a transition period (proposal: yes, one release).
- Port: 3100 by default; pimatrix keeps 3000.
