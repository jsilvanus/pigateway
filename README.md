# pigateway

The one process on the Raspberry Pi that talks to the devices: ATEM switcher, PTZ cameras (VISCA and CGI), the AMX master, the Matrox Monarch HDX encoder (`/api/v1/encoder`, env `PIGATEWAY_ENCODER_*`), YouTube live status from pitube, and PiVoice audio telemetry. Other services call its HTTP API and listen to its events (`GET /api/v1/events`, Server-Sent Events). Video processing stays in [pimatrix](https://github.com/jsilvanus/pimatrix); YouTube is [pitube](https://github.com/jsilvanus/pitube). Plan and phases: [docs/plan.md](docs/plan.md).

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

## Endpoints

`GET /health`, `GET /api/v1/status`, `GET /api/v1/events`, `/api/v1/atem/*`, `/api/v1/cameras/*`.

## API description and CLI

[openapi/openapi.json](openapi/openapi.json) describes the HTTP endpoints; a test fails when it and the served routes differ. `bin/pigateway.mjs` (also installed as `pigateway`) builds one command per operation from that file at run time, with no dependencies.

## AMX

The gateway listens for the AMX on `PIGATEWAY_AMX_TCP_PORT` (6600) and speaks the same line protocol pimatrix did. `CAM`, `DEV`, `PING` and the camera and Atlona parts of `STATUS:ALL` are answered here. `SOURCE`, `OUTPUT`, `QUICK` and `PROGRAM` are forwarded to pimatrix's own AMX listener (`PIGATEWAY_VIDEO_AMX_HOST/PORT`), so the AMX program does not change. Atlona routing (`POST /api/v1/matrix/route`, plus `/api/v1/matrix` and `/matrix/lock`) is sent to the AMX master on 6501.

## Configuration

See [.env.example](.env.example). Camera and ATEM addresses, MediaMTX push URLs, API key, LAN allow list, CORS origins.

Unverified against the real ATEM and cameras since the code was moved from pimatrix; the tests use fakes.
