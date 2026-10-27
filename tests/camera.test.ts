import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { buildApp } from "../src/app.js";
import http from "node:http";
import {
  parseFreedState,
  SimulatedCameraAdapter,
  UdpViscaCameraAdapter
} from "../src/camera/camera-adapter.js";
import {
  buildPanTiltDrive,
  buildPower,
  buildPresetRecall,
  buildPresetSave,
  buildSmartFrame,
  buildZoom,
  createViscaPacket,
  parseViscaResponse
} from "../src/camera/visca-protocol.js";
import { loadConfig } from "../src/config.js";

test("VISCA packet builder and parser encode correct binary frames", () => {
  const panDrive = buildPanTiltDrive("up", 12, 10);
  assert.deepEqual(panDrive, [0x81, 0x01, 0x06, 0x01, 12, 10, 0x03, 0x01, 0xff]);

  const packet = createViscaPacket(panDrive, 42);
  assert.equal(packet.readUInt16BE(0), 0x0100);
  assert.equal(packet.readUInt16BE(2), 9);
  assert.equal(packet.readUInt32BE(4), 42);
  assert.equal(packet[8], 0x81);
  assert.equal(packet[16], 0xff);

  const smartFramePacket = buildSmartFrame("enable");
  assert.deepEqual(smartFramePacket, [0x81, 0x01, 0x04, 0x3f, 0x02, 0x5a, 0xff]);

  const smartFrameTrigger = buildSmartFrame("trigger");
  assert.deepEqual(smartFrameTrigger, [0x81, 0x01, 0x04, 0x3f, 0x02, 0x5c, 0xff]);

  const presetRecall = buildPresetRecall(5);
  assert.deepEqual(presetRecall, [0x81, 0x01, 0x04, 0x3f, 0x02, 0x05, 0xff]);

  const presetSave = buildPresetSave(12);
  assert.deepEqual(presetSave, [0x81, 0x01, 0x04, 0x3f, 0x01, 0x0c, 0xff]);

  const zoomIn = buildZoom("in", 5);
  assert.deepEqual(zoomIn, [0x81, 0x01, 0x04, 0x07, 0x25, 0xff]);

  // Reply parsing
  const ackBuffer = Buffer.from([0x01, 0x11, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x90, 0x41, 0xff]);
  const parsedAck = parseViscaResponse(ackBuffer);
  assert.ok(parsedAck);
  assert.equal(parsedAck.isAck, true);
  assert.equal(parsedAck.isCompletion, false);
});

test("SimulatedCameraAdapter moves, zooms, stores presets, and updates SmartFrame", async () => {
  const adapter = new SimulatedCameraAdapter("cam1", "Camera 1");
  const initial = adapter.getSnapshot();
  assert.equal(initial.id, "cam1");
  assert.equal(initial.position.pan, 0);
  assert.equal(initial.smartFrame, "disabled");

  await adapter.move("right", 10, 10);
  assert.equal(adapter.getSnapshot().position.pan, 50);

  await adapter.zoom("in", 4);
  assert.ok(adapter.getSnapshot().position.zoom > 0);

  await adapter.savePreset(10, "Custom 10");
  assert.ok(adapter.getSnapshot().presets.some((p) => p.id === 10 && p.name === "Custom 10"));

  await adapter.recallPreset(1);
  assert.equal(adapter.getSnapshot().position.pan, 100);

  await adapter.setSmartFrame("enable");
  assert.equal(adapter.getSnapshot().smartFrame, "enabled");

  const streamUrl = await adapter.startStream();
  assert.equal(adapter.getSnapshot().streaming, true);
  assert.ok(streamUrl?.includes("cam1"));

  await adapter.stopStream();
  assert.equal(adapter.getSnapshot().streaming, false);
  await adapter.close();
});

test("Camera REST API endpoints handle listing, control, presets, smartframe, and stream toggle", async () => {
  const config = loadConfig({ PIGATEWAY_MODE: "simulation" });
  const app = buildApp(config);

  // List cameras
  const listRes = await app.inject({ method: "GET", url: "/api/v1/cameras" });
  assert.equal(listRes.statusCode, 200);
  const listJson = listRes.json();
  assert.equal(listJson.items.length, 2);
  assert.equal(listJson.items[0].id, "cam1");
  assert.equal(listJson.items[1].id, "cam2");

  // Get single camera
  const getRes = await app.inject({ method: "GET", url: "/api/v1/cameras/cam1" });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().id, "cam1");

  // 404 for unknown camera
  const notFoundRes = await app.inject({ method: "GET", url: "/api/v1/cameras/unknown-cam" });
  assert.equal(notFoundRes.statusCode, 404);

  // Move camera
  const moveRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/move",
    payload: { direction: "up", panSpeed: 10, tiltSpeed: 15 }
  });
  assert.equal(moveRes.statusCode, 200);
  assert.equal(moveRes.json().success, true);
  assert.equal(moveRes.json().action, "move:up");

  // Invalid direction
  const badMoveRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/move",
    payload: { direction: "sideways" }
  });
  assert.equal(badMoveRes.statusCode, 422);

  // Zoom camera
  const zoomRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/zoom",
    payload: { action: "in", speed: 5 }
  });
  assert.equal(zoomRes.statusCode, 200);
  assert.equal(zoomRes.json().action, "zoom:in");

  // Recall preset
  const recallRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/presets/1/recall"
  });
  assert.equal(recallRes.statusCode, 200);
  assert.equal(recallRes.json().action, "preset:recall:1");

  // Save preset
  const saveRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/presets/7/save",
    payload: { name: "Choir Back" }
  });
  assert.equal(saveRes.statusCode, 200);
  assert.equal(saveRes.json().action, "preset:save:7");

  // SmartFrame
  const sfRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/smartframe",
    payload: { mode: "enable" }
  });
  assert.equal(sfRes.statusCode, 200);
  assert.equal(sfRes.json().action, "smartframe:enable");

  // Stream start & stop
  const streamStartRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/stream/start"
  });
  assert.equal(streamStartRes.statusCode, 200);
  assert.equal(streamStartRes.json().streaming, true);

  const streamStopRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/stream/stop"
  });
  assert.equal(streamStopRes.statusCode, 200);
  assert.equal(streamStopRes.json().streaming, false);

  await app.close();
});

test("UdpViscaCameraAdapter transmits valid VISCA packets over UDP to mock target", async () => {
  const server = dgram.createSocket("udp4");
  const receivedPackets: Buffer[] = [];

  await new Promise<void>((resolve) => {
    server.bind(0, "127.0.0.1", () => resolve());
  });

  server.on("message", (msg) => {
    receivedPackets.push(msg);
  });

  const port = server.address().port;

  const adapter = new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    viscaPort: port
  });

  await adapter.move("down", 8, 9);
  await adapter.setSmartFrame("trigger");
  await adapter.recallPreset(3);

  // Wait briefly for UDP delivery
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(receivedPackets.length, 3);

  // First packet: PanTilt down
  const p1 = receivedPackets[0]!;
  assert.equal(p1.readUInt16BE(0), 0x0100);
  assert.equal(p1[8], 0x81);
  assert.equal(p1[14], 0x03); // Down
  assert.equal(p1[15], 0x02);

  // Second packet: SmartFrame trigger (0x5C)
  const p2 = receivedPackets[1]!;
  assert.equal(p2[11], 0x3f);
  assert.equal(p2[12], 0x02);
  assert.equal(p2[13], 0x5c);

  // Third packet: Recall preset 3
  const p3 = receivedPackets[2]!;
  assert.equal(p3[13], 0x03);

  await adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("privacy blur sends focus manual, near limit, near drive, stop; off returns to AF", async () => {
  const server = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
  server.on("message", (msg) => received.push(msg));

  const adapter = new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    viscaPort: server.address().port,
    focusDriveMs: 10,
    nearLimitM: 1.5
  });

  await adapter.setPrivacyBlur(true);
  assert.equal(adapter.getSnapshot().privacyBlur, true);
  await adapter.setPrivacyBlur(false);
  assert.equal(adapter.getSnapshot().privacyBlur, false);
  await new Promise((r) => setTimeout(r, 80));

  const bodies = received.map((p) => [...p.subarray(8)]);
  assert.deepEqual(bodies, [
    [0x81, 0x01, 0x04, 0x38, 0x03, 0xff],
    [0x81, 0x01, 0x04, 0x28, 0x0f, 0x00, 0x00, 0x00, 0xff],
    [0x81, 0x01, 0x04, 0x08, 0x37, 0xff],
    [0x81, 0x01, 0x04, 0x08, 0x00, 0xff],
    [0x81, 0x01, 0x04, 0x28, 0x01, 0x0e, 0x0e, 0x0f, 0xff],
    [0x81, 0x01, 0x04, 0x38, 0x02, 0xff]
  ]);

  await adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("SimulatedCameraAdapter tracks privacy blur", async () => {
  const adapter = new SimulatedCameraAdapter("cam1", "Camera 1");
  assert.equal(adapter.getSnapshot().privacyBlur, false);
  await adapter.setPrivacyBlur(true);
  assert.equal(adapter.getSnapshot().privacyBlur, true);
});

test("focus mode sends VISCA auto/manual and auto ends a privacy blur", async () => {
  const server = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
  server.on("message", (msg) => received.push(msg));

  const adapter = new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    viscaPort: server.address().port
  });

  await adapter.setFocusMode("manual");
  assert.equal(adapter.getSnapshot().focusMode, "manual");
  await adapter.setFocusMode("auto");
  assert.equal(adapter.getSnapshot().focusMode, "auto");
  await new Promise((r) => setTimeout(r, 50));

  const bodies = received.map((p) => [...p.subarray(8)]);
  assert.deepEqual(bodies, [
    [0x81, 0x01, 0x04, 0x38, 0x03, 0xff],
    [0x81, 0x01, 0x04, 0x38, 0x02, 0xff]
  ]);

  await adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("SimulatedCameraAdapter tracks focus mode", async () => {
  const adapter = new SimulatedCameraAdapter("cam1", "Camera 1");
  assert.equal(adapter.getSnapshot().focusMode, "auto");
  await adapter.setPrivacyBlur(true);
  assert.equal(adapter.getSnapshot().focusMode, "manual");
  await adapter.setFocusMode("auto");
  assert.equal(adapter.getSnapshot().privacyBlur, false);
});

test("VISCA power frames: on wakes, off sends to standby", () => {
  assert.deepEqual(buildPower(true), [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]);
  assert.deepEqual(buildPower(false), [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]);
});

test("UdpViscaCameraAdapter sends power from the VISCA source port", async () => {
  const server = dgram.createSocket("udp4");
  const received: { body: number[]; port: number }[] = [];
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
  server.on("message", (msg, rinfo) => received.push({ body: [...msg.subarray(8)], port: rinfo.port }));

  // Port 0 = any free source port in tests; production defaults to 52381.
  const adapter = new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    viscaPort: server.address().port,
    viscaSourcePort: 0
  });

  await adapter.setPower(false);
  await adapter.setPower(true);
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(
    received.map((r) => r.body),
    [
      [0x81, 0x01, 0x04, 0x00, 0x03, 0xff],
      [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]
    ]
  );

  await adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("SimulatedCameraAdapter accepts power commands", async () => {
  const adapter = new SimulatedCameraAdapter("cam1", "Camera 1");
  await adapter.setPower(false);
  await adapter.setPower(true);
  assert.equal(adapter.getSnapshot().id, "cam1");
});

test("Camera power REST endpoint validates and answers", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));

  const onRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/power",
    payload: { on: true }
  });
  assert.equal(onRes.statusCode, 200);
  assert.equal(onRes.json().action, "power:on");

  const standbyRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/power",
    payload: { on: false }
  });
  assert.equal(standbyRes.statusCode, 200);
  assert.equal(standbyRes.json().action, "power:standby");

  const badRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/power",
    payload: { on: "yes" }
  });
  assert.equal(badRes.statusCode, 422);

  const missingRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/unknown-cam/power",
    payload: { on: true }
  });
  assert.equal(missingRes.statusCode, 404);

  await app.close();
});

test("parseFreedState reads get_net_cfg key=value pairs and rejects answers without freed_enable", () => {
  const state = parseFreedState("freed_enable=1;freed_cam_id=101;freed_addr=192.168.1.77;freed_port_num=40000;");
  assert.deepEqual(state, { enabled: true, camId: 101, addr: "192.168.1.77", port: 40000 });
  assert.equal(parseFreedState("freed_enable=0;freed_cam_id=102")?.enabled, false);
  assert.equal(parseFreedState("ip=1.2.3.4;"), null);
  assert.equal(parseFreedState("freed_enable=maybe"), null);
});

test("UdpViscaCameraAdapter FreeD: target, enable and read-back go to the /storks/ CGI with login", async () => {
  const calls: { method: string | undefined; url: string | undefined; auth: string | undefined }[] = [];
  let netCfg = "freed_enable=0;freed_cam_id=101;freed_addr=192.168.1.77;freed_port_num=40000;";
  const cgi = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url?.includes("set_freed_enable:1")) netCfg = netCfg.replace("freed_enable=0", "freed_enable=1");
    if (req.url?.includes("set_freed_enable:0")) netCfg = netCfg.replace("freed_enable=1", "freed_enable=0");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(req.url?.includes("get_net_cfg") ? netCfg : "");
  });
  await new Promise<void>((resolve) => cgi.listen(0, "127.0.0.1", () => resolve()));

  const adapter = new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    cgiPort: (cgi.address() as { port: number }).port,
    auth: { user: "admin", password: "secret" },
    viscaSourcePort: 0
  });

  const before = await adapter.getFreed();
  assert.equal(before.enabled, false);

  const after = await adapter.setFreed(true, { camId: 101, addr: "192.168.1.77", port: 40000 });
  assert.equal(after.enabled, true);
  assert.equal(after.addr, "192.168.1.77");

  const off = await adapter.setFreed(false);
  assert.equal(off.enabled, false);

  assert.ok(calls.every((c) => c.url?.startsWith("/storks/?cmd=")));
  assert.ok(calls.every((c) => c.auth === `Basic ${Buffer.from("admin:secret").toString("base64")}`));
  assert.equal(calls[1]?.url, "/storks/?cmd=set_freed_config{freed_cam_id:101,freed_addr:192.168.1.77,freed_port_num:40000}");
  assert.equal(calls[2]?.url, "/storks/?cmd=set_freed_enable:1");

  await adapter.close();
  await new Promise<void>((resolve) => cgi.close(() => resolve()));
});

test("Camera FreeD REST endpoints: read, toggle with target, validate", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));

  const getRes = await app.inject({ method: "GET", url: "/api/v1/cameras/cam1/freed" });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().freed.enabled, false);

  const onRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/freed",
    payload: { enabled: true, target: { camId: 101, addr: "192.168.1.77", port: 40000 } }
  });
  assert.equal(onRes.statusCode, 200);
  assert.equal(onRes.json().action, "freed:on");
  assert.equal(onRes.json().freed.port, 40000);

  const offRes = await app.inject({ method: "POST", url: "/api/v1/cameras/cam1/freed", payload: { enabled: false } });
  assert.equal(offRes.statusCode, 200);
  assert.equal(offRes.json().freed.enabled, false);

  const badEnabled = await app.inject({ method: "POST", url: "/api/v1/cameras/cam1/freed", payload: { enabled: "yes" } });
  assert.equal(badEnabled.statusCode, 422);

  const badTarget = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/freed",
    payload: { enabled: true, target: { camId: 101, addr: "not-an-ip", port: 40000 } }
  });
  assert.equal(badTarget.statusCode, 422);

  const missing = await app.inject({ method: "GET", url: "/api/v1/cameras/unknown-cam/freed" });
  assert.equal(missing.statusCode, 404);

  await app.close();
});
