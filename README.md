# pigateway

The one process on the Raspberry Pi that talks to the devices: ATEM switcher, PTZ cameras (VISCA and CGI), the AMX master, the Matrox Monarch HDX encoder (`/api/v1/encoder`, env `PIGATEWAY_ENCODER_*`), YouTube live status from pitube, PiVoice audio telemetry and activity-session lifecycle. Other services call its HTTP API and listen to its events (`GET /api/v1/events`, Server-Sent Events). Video processing stays in [pimatrix](https://github.com/jsilvanus/pimatrix); YouTube is [pitube](https://github.com/jsilvanus/pitube). Plan and phases: [docs/plan.md](docs/plan.md).

## Run

```sh
npm install
npm run build && npm start      # or: npm run dev
npm test
```

Needs Node 22 or newer (Node 24 on the Pi). `PIGATEWAY_MODE=simulation` (default) fakes the cameras; `production` talks to the hardware and requires `PIGATEWAY_API_KEY`.

## PiVoice telemetry

PiGateway listens for the binary PiVoice telemetry protocol on UDP `PIGATEWAY_PIVOICE_UDP_HOST` / `PIGATEWAY_PIVOICE_UDP_PORT` (defaults `0.0.0.0:3101`), separately from the HTTP API on port 3100. Set `PIGATEWAY_PIVOICE_ALLOWED_HOSTS` to a comma-separated list of sender IPs to restrict who can update telemetry.

The shared [protocol specification](docs/pivoice-telemetry.md) defines the packet. The v1 packet is 42 bytes: a 20-byte header and a 22-byte snapshot payload. It uses big-endian integers, magic `PV`, version 1, type `0x01` for capture snapshots and type `0x02` for completed health/status polls. PiVoice sends periodic snapshots only while capturing, and no idle heartbeat packets. A valid packet refreshes the six-second TTL; when it expires, the gateway marks the retained snapshot stale rather than erasing it. `lastPollAt` records the last completed poll. Invalid packets and packets from disallowed IPs do not update state.

Latest state is included in `GET /api/v1/status` under `pivoice`; the same state is emitted as the `pivoice` event on `GET /api/v1/events`. State is held in memory. The sample format is `unknown` until PiVoice can report the negotiated ALSA input format rather than assuming it.

## FreeD camera tracking telemetry

PiGateway hosts the incoming UDP listener for the standard **FreeD D1 protocol** (29-byte camera tracking datagrams containing pan, tilt, roll, XYZ positions, zoom and focus). By default, it listens on UDP port `40000` (`PIGATEWAY_FREED_UDP_PORT`, default host `0.0.0.0`). Set `PIGATEWAY_FREED_ALLOWED_HOSTS` to restrict sender IPs.

Incoming tracking datagrams are validated via FreeD checksum verification and decoded into metric/degree telemetry:
- Pan, Tilt, Roll in degrees
- X, Y, Z positions in millimetres
- Optical zoom and focus positions

The decoded telemetry is broadcast live on Server-Sent Events (`GET /api/v1/events`, event type `freed`) and returned on `GET /api/v1/cameras/:cameraId/freed`. Direct camera controls can also be coordinated with the standalone **`picam`** service via `PIGATEWAY_PICAM_API_URL`.

## PiVoice activity sessions

Set `PIGATEWAY_PIVOICE_API_URL` (for example `http://127.0.0.1:8095`) and `PIGATEWAY_PIVOICE_API_TOKEN` to the PiVoice control API and its bearer token. PiGateway observes speech/music classifications over UDP, asks PiVoice to open a live Auditor session, and owns the idle-close timer. PiVoice sends its rolling PCM pre-roll to Auditor; neither audio nor PCM passes through PiGateway. `PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS` defaults to 15 seconds; `0` disables automatic close. Read or change the setting with `GET /api/v1/activity/idle-close` and `PUT /api/v1/activity/idle-close` using `{"idleCloseSeconds":30}`. Current coordinator state is included in `/api/v1/status` and emitted as `pivoice-activity` events.

## Endpoints

`GET /health`, `GET /api/v1/status`, `GET /api/v1/ecosystem`, `POST /api/v1/ecosystem/probe`, `GET /api/v1/events`, `/api/v1/atem/*`, `/api/v1/cameras/*`, `/api/v1/activity/idle-close`.

## Ecosystem discovery & in-use plugin tracking

PiGateway tracks availability and in-use status of all Pi ecosystem services (`pisound`, `pivoice`, `pitube`, `pilight`, `pimatrix`, `piprogram`, `picanva`, `auditor`, `radioRelay`, and attached devices like ATEM, encoder, and cameras).
- `GET /api/v1/status` includes `ecosystem`, `activePlugins` (list of active plugin IDs), and `inUseTabs` (list of active UI tabs, e.g. `["sound", "voice", "youtube", "tally", "atem"]`). Browser interfaces like `picontrol` can inspect `inUseTabs` to selectively render only the tabs that are currently active in the venue.
- `GET /api/v1/ecosystem` returns detailed status per component.
- `POST /api/v1/ecosystem/probe` actively triggers an immediate health probe of all endpoints.
- Real-time changes are emitted as `ecosystem` events on `GET /api/v1/events` (SSE).
- If PiSound is not active or enabled (`PIGATEWAY_PISOUND_ENABLED=false` or auto-probe fails), PiGateway skips binding the PiSound UDP telemetry listener on port 3102. If PiSound comes online later, the listener is started dynamically.

## API description and CLI

[openapi/openapi.json](openapi/openapi.json) describes the HTTP endpoints; a test fails when it and the served routes differ. `bin/pigateway.mjs` (also installed as `pigateway`) builds one command per operation from that file at run time, with no dependencies.

## AMX

The gateway listens for the AMX on `PIGATEWAY_AMX_TCP_PORT` (6600) and speaks the same line protocol pimatrix did. `CAM`, `DEV`, `PING` and the camera and Atlona parts of `STATUS:ALL` are answered here. `SOURCE`, `OUTPUT`, `QUICK` and `PROGRAM` are forwarded to pimatrix's own AMX listener (`PIGATEWAY_VIDEO_AMX_HOST/PORT`), so the AMX program does not change. Atlona routing (`POST /api/v1/matrix/route`, plus `/api/v1/matrix` and `/matrix/lock`) is sent to the AMX master on 6501.

## Configuration

See [.env.example](.env.example). Camera and ATEM addresses, MediaMTX push URLs, API key, LAN allow list, CORS origins.

Unverified against the real ATEM and cameras since the code was moved from pimatrix; the tests use fakes.
