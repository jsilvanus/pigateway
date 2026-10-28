# pigateway plan (2026-10-28)

pigateway is the one process on the Pi that holds connections to devices and exposes a controlled API. It owns device state and publishes it as events. It does no video/audio work; ffmpeg, MediaMTX, HDMI out, effects and composites stay in their dedicated services.

## Rules

- Small and boring: Node 24 ESM, Fastify, systemd restart, watchdogs on every socket, no database.
- Writes need `PIGATEWAY_API_KEY` unless the client is on `PIGATEWAY_AUTH_ALLOWED_HOSTS`.
- Do not deploy or contact live devices as part of implementation.

## PiVoice activity-session coordination

PiGateway owns the lifecycle for activity-triggered Auditor sessions. PiVoice remains the audio owner and sends pre-roll directly to Auditor; audio bytes never transit this gateway.

- Receive PiVoice's existing binary UDP telemetry and use speech/music classification.
- Select triggers using `PIGATEWAY_PIVOICE_START_WHEN=speech|speech_or_music` (default `speech_or_music`).
- Call PiVoice's authenticated control API using `PIGATEWAY_PIVOICE_API_URL` and `PIGATEWAY_PIVOICE_API_TOKEN`.
- Own the idle-close timer through `PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS` (default 15; zero disables automatic close).
- Publish coordinator state in `GET /api/v1/status` and the `pivoice-activity` SSE event.

## Web radio relay integration (planned; implementation required)

PiGateway will be a control-plane client for web-radio-relay. It does not ingest, buffer or proxy audio. PiVoice/MediaMTX sends audio directly to the relay's configured input; the relay alone owns its FFmpeg process and HLS/archive lifecycle.

- Configure `PIGATEWAY_RADIO_RELAY_API_URL` and `PIGATEWAY_RADIO_RELAY_API_TOKEN` together; reject configuration where only one is supplied.
- Add authenticated gateway routes to start, stop and query the lifecycle of a configured stream name. Do not allow callers to submit arbitrary source URLs through PiGateway.
- Call relay `/api/v1/streams/{name}/start`, `/stop` and `/lifecycle` with bearer auth, strict timeout, and sanitized errors.
- Include relay configuration/connectivity and last known response in `GET /api/v1/status`; do not report a relay stream as running unless the relay says so.
- Keep the gateway API's own authentication policy in force; the relay token is only used server-to-server.
- Keep the PiGateway OpenAPI document and runtime-generated CLI in sync.

## Relay lifecycle contract dependency

The integration depends on web-radio-relay implementing authenticated lifecycle routes and an FFmpeg supervisor. Until those routes exist and pass tests, PiGateway must not claim to manage relay lifecycle. Do not silently fall back to the old RTMP publisher mechanism for RTSP source-pull control.

## Acceptance

- Build and tests pass.
- PiVoice activity start/open/idle-close/shutdown behavior remains unchanged.
- Relay start/stop/query commands work with a mocked relay; timeout, auth failure, relay outage and malformed responses are visible as errors.
- Integration tests prove no audio payload is sent through PiGateway.
- Real Pi/church-audio validation and deployment are separate tasks.
