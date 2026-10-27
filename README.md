# pigateway

The one process on the Raspberry Pi that talks to the devices: ATEM switcher, PTZ cameras (VISCA and CGI) and, next, the AMX master, tally light and encoder. Other services call its HTTP API and listen to its events (`GET /api/v1/events`, Server-Sent Events). Video processing stays in [pimatrix](https://github.com/jsilvanus/pimatrix); YouTube is [pitube](https://github.com/jsilvanus/pitube). Plan and phases: [docs/plan.md](docs/plan.md).

## Run

```sh
npm install
npm run build && npm start      # or: npm run dev
npm test
```

Needs Node 22 or newer (Node 24 on the Pi). `PIGATEWAY_MODE=simulation` (default) fakes the cameras; `production` talks to the hardware and requires `PIGATEWAY_API_KEY`.

## Endpoints (same as pimatrix had)

`GET /health`, `GET /api/v1/status`, `GET /api/v1/events`, `/api/v1/atem/*` (program, preview, cut, auto, ftb, DSK tie and on-air), `/api/v1/cameras/*` (move, zoom, presets, smartframe, focus, power, FreeD, privacy blur, stream start and stop).

## API description and CLI

[openapi/openapi.json](openapi/openapi.json) describes every endpoint; a test fails when it and the served routes differ. `bin/pigateway.mjs` (also installed as `pigateway`) builds one command per operation from that file at run time, with no dependencies:

```sh
pigateway help                                  # all commands
pigateway help set-atem-dsk-on-air
PIGATEWAY_URL=http://kirkonpi.local:3100 PIGATEWAY_API_KEY=... pigateway move-camera --cameraId cam1 --direction left
pigateway upload-atem-still --slot 1 --file slide.rgba
```

## AMX

The gateway listens for the AMX on `PIGATEWAY_AMX_TCP_PORT` (6600) and speaks the same line protocol pimatrix did. `CAM`, `DEV`, `PING` and the camera and Atlona parts of `STATUS:ALL` are answered here. `SOURCE`, `OUTPUT`, `QUICK` and `PROGRAM` are forwarded to pimatrix's own AMX listener (`PIGATEWAY_VIDEO_AMX_HOST/PORT`), so the AMX program does not change. Atlona routing (`POST /api/v1/matrix/route`, plus `/api/v1/matrix` and `/matrix/lock`) is sent to the AMX master on 6501.

## Configuration

See [.env.example](.env.example). Camera and ATEM addresses, MediaMTX push URLs, API key, LAN allow list, CORS origins.

Unverified against the real ATEM and cameras since the code was moved from pimatrix; the tests use fakes.
