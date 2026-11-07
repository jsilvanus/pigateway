import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import Fastify from "fastify";
import {
  decodeTrackingPacket,
  ScreenTrackingUdpReceiver,
} from "../src/perception/tracking-receiver.js";
import { registerPerceptionRoutes } from "../src/perception/perception-routes.js";
import { PiPerceptionClient } from "../src/perception/client.js";
import { GatewayEventBroker } from "../src/events.js";

// Helper to encode binary tracking packet
function buildBinaryPacket(data: {
  sequence: number;
  timestampMs: number;
  cameraId: string;
  objects: Array<{
    trackId: number;
    confidence: number;
    classId: number;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
    vx: number;
    vy: number;
  }>;
}): Buffer {
  const camIdBuf = Buffer.from(data.cameraId, "utf8");
  const camIdLen = camIdBuf.length;
  const objectCount = data.objects.length;
  const buf = Buffer.alloc(20 + camIdLen + objectCount * 18);

  let offset = 0;
  buf.writeUInt16BE(0x5054, offset); // "PT"
  offset += 2;
  buf.writeUInt8(1, offset); // version
  offset += 1;
  buf.writeUInt8(1, offset); // snapshot
  offset += 1;
  buf.writeUInt16BE(0, offset); // flags
  offset += 2;
  buf.writeUInt32BE(data.sequence, offset);
  offset += 4;
  buf.writeBigUInt64BE(BigInt(data.timestampMs), offset);
  offset += 8;

  buf.writeUInt8(camIdLen, offset);
  offset += 1;
  camIdBuf.copy(buf, offset);
  offset += camIdLen;

  buf.writeUInt8(objectCount, offset);
  offset += 1;

  for (const obj of data.objects) {
    buf.writeUInt16BE(obj.trackId, offset);
    offset += 2;
    buf.writeUInt8(obj.confidence, offset);
    offset += 1;
    buf.writeUInt8(obj.classId, offset);
    offset += 1;

    buf.writeUInt16BE(Math.round(obj.ymin * 65535), offset);
    offset += 2;
    buf.writeUInt16BE(Math.round(obj.xmin * 65535), offset);
    offset += 2;
    buf.writeUInt16BE(Math.round(obj.ymax * 65535), offset);
    offset += 2;
    buf.writeUInt16BE(Math.round(obj.xmax * 65535), offset);
    offset += 2;

    buf.writeInt16BE(Math.round(obj.vx * 10000), offset);
    offset += 2;
    buf.writeInt16BE(Math.round(obj.vy * 10000), offset);
    offset += 2;

    buf.writeUInt16BE(0, offset); // reserved
    offset += 2;
  }

  return buf;
}

test("decodeTrackingPacket decodes binary wire packet accurately", () => {
  const packetBuf = buildBinaryPacket({
    sequence: 42,
    timestampMs: 1730975000000,
    cameraId: "cam1",
    objects: [
      {
        trackId: 10,
        confidence: 95,
        classId: 0,
        ymin: 0.1,
        xmin: 0.2,
        ymax: 0.8,
        xmax: 0.6,
        vx: 0.02,
        vy: -0.01,
      },
    ],
  });

  const decoded = decodeTrackingPacket(packetBuf);
  assert.ok(decoded);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.cameraId, "cam1");
  assert.equal(decoded.objects.length, 1);

  const obj = decoded.objects[0]!;
  assert.equal(obj.trackId, 10);
  assert.equal(obj.confidence, 95);
  assert.equal(obj.label, "person");
  assert.ok(Math.abs(obj.bbox[0] - 0.1) < 0.001);
  assert.ok(Math.abs(obj.bbox[1] - 0.2) < 0.001);
  assert.ok(Math.abs(obj.rect.x - 0.2) < 0.001);
  assert.ok(Math.abs(obj.rect.y - 0.1) < 0.001);
  assert.ok(Math.abs(obj.rect.w - 0.4) < 0.001);
  assert.ok(Math.abs(obj.rect.h - 0.7) < 0.001);
});

test("decodeTrackingPacket decodes JSON fallback", () => {
  const jsonBuf = Buffer.from(
    JSON.stringify({
      type: "screen-tracking",
      sequence: 12,
      cameraId: "cam2",
      objects: [
        {
          trackId: 5,
          confidence: 88,
          bbox: [0.2, 0.3, 0.7, 0.5],
        },
      ],
    })
  );

  const decoded = decodeTrackingPacket(jsonBuf);
  assert.ok(decoded);
  assert.equal(decoded.cameraId, "cam2");
  assert.equal(decoded.objects.length, 1);
  assert.equal(decoded.objects[0]!.trackId, 5);
  assert.equal(decoded.objects[0]!.rect.x, 0.3);
  assert.equal(decoded.objects[0]!.rect.y, 0.2);
});

test("ScreenTrackingUdpReceiver tracks varying number of feeds and emits broker events", async () => {
  const eventBroker = new GatewayEventBroker();
  const events: any[] = [];
  eventBroker.subscribe((evt) => events.push(evt));

  const receiver = new ScreenTrackingUdpReceiver({
    host: "127.0.0.1",
    port: 0, // ephemeral port
    eventBroker,
  });

  await receiver.start();
  const boundPort = receiver.getBoundPort();
  assert.ok(boundPort > 0);

  const client = dgram.createSocket("udp4");

  // Send packet for cam1
  const cam1Buf = buildBinaryPacket({
    sequence: 1,
    timestampMs: Date.now(),
    cameraId: "cam1",
    objects: [
      {
        trackId: 1,
        confidence: 90,
        classId: 0,
        ymin: 0.1,
        xmin: 0.2,
        ymax: 0.5,
        xmax: 0.4,
        vx: 0,
        vy: 0,
      },
    ],
  });

  await new Promise<void>((resolve, reject) => {
    client.send(cam1Buf, 0, cam1Buf.length, boundPort, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Send packet for cam2
  const cam2Buf = buildBinaryPacket({
    sequence: 2,
    timestampMs: Date.now(),
    cameraId: "cam2",
    objects: [
      {
        trackId: 2,
        confidence: 85,
        classId: 0,
        ymin: 0.3,
        xmin: 0.4,
        ymax: 0.9,
        xmax: 0.8,
        vx: 0.01,
        vy: 0,
      },
    ],
  });

  await new Promise<void>((resolve, reject) => {
    client.send(cam2Buf, 0, cam2Buf.length, boundPort, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Allow event loop to process UDP messages
  await new Promise((r) => setTimeout(r, 80));

  const state = receiver.getState();
  assert.equal(state.listening, true);
  assert.equal(state.packetCount, 2);
  assert.ok(state.feeds["cam1"]);
  assert.ok(state.feeds["cam2"]);
  assert.equal(state.feeds["cam1"]!.objects[0]!.trackId, 1);
  assert.equal(state.feeds["cam2"]!.objects[0]!.trackId, 2);

  // Broker events
  const screenEvts = events.filter((e) => e.type === "screen-tracking");
  assert.equal(screenEvts.length, 2);
  const perceptionEvts = events.filter((e) => e.type === "perception");
  assert.equal(perceptionEvts.length, 2);

  // Test Fastify screen-tracks endpoint
  const app = Fastify();
  registerPerceptionRoutes(app, {
    client: new PiPerceptionClient({}),
    eventBroker,
    trackingReceiver: receiver,
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/perception/screen-tracks",
  });
  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.equal(json.listening, true);
  assert.ok(json.feeds.cam1);
  assert.ok(json.feeds.cam2);

  client.close();
  await receiver.stop();
  await app.close();
});

test("ScreenTrackingUdpReceiver drops identical content packets early without duplicate broker events", async () => {
  const eventBroker = new GatewayEventBroker();
  const events: any[] = [];
  eventBroker.subscribe((evt) => events.push(evt));

  const receiver = new ScreenTrackingUdpReceiver({
    host: "127.0.0.1",
    port: 0,
    eventBroker,
  });

  await receiver.start();
  const boundPort = receiver.getBoundPort();
  const client = dgram.createSocket("udp4");

  const send = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      client.send(buf, 0, buf.length, boundPort, "127.0.0.1", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  const packet1 = buildBinaryPacket({
    sequence: 1,
    timestampMs: 1000,
    cameraId: "cam1",
    objects: [{ trackId: 1, confidence: 90, classId: 0, ymin: 0.1, xmin: 0.2, ymax: 0.5, xmax: 0.4, vx: 0, vy: 0 }],
  });

  // Packet 2 has different sequence and timestamp, but identical tracking data
  const packet2 = buildBinaryPacket({
    sequence: 2,
    timestampMs: 1100,
    cameraId: "cam1",
    objects: [{ trackId: 1, confidence: 90, classId: 0, ymin: 0.1, xmin: 0.2, ymax: 0.5, xmax: 0.4, vx: 0, vy: 0 }],
  });

  // Packet 3 has moved object
  const packet3 = buildBinaryPacket({
    sequence: 3,
    timestampMs: 1200,
    cameraId: "cam1",
    objects: [{ trackId: 1, confidence: 90, classId: 0, ymin: 0.2, xmin: 0.3, ymax: 0.6, xmax: 0.5, vx: 0.05, vy: 0 }],
  });

  await send(packet1);
  await send(packet2); // identical content, should be dropped early
  await send(packet3); // changed content, should be emitted

  await new Promise((r) => setTimeout(r, 60));

  const screenEvts = events.filter((e) => e.type === "screen-tracking");
  // Only 2 events emitted (packet1 and packet3), packet2 was dropped early
  assert.equal(screenEvts.length, 2);
  assert.equal(screenEvts[0]!.data.sequence, 1);
  assert.equal(screenEvts[1]!.data.sequence, 3);

  // Packet count still accounts for all received packets
  const state = receiver.getState();
  assert.equal(state.packetCount, 3);
  assert.equal(state.feeds.cam1!.sequence, 3);

  client.close();
  await receiver.stop();
});

test("perception feed proxy routes forward to PiPerceptionClient", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (pathname === "/api/v1/feeds") {
      return new Response(JSON.stringify([{ config: { cameraId: "cam1" }, status: "active" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (pathname === "/api/v1/feeds/cam1/start") {
      return new Response(JSON.stringify({ ok: true, cameraId: "cam1", running: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new PiPerceptionClient({
    baseUrl: "http://127.0.0.1:3202",
    fetchFn: fakeFetch,
  });

  registerPerceptionRoutes(app, { client });

  const getFeedsRes = await app.inject({ method: "GET", url: "/api/v1/perception/feeds" });
  assert.equal(getFeedsRes.statusCode, 200);
  assert.equal(calls[0]!.path, "/api/v1/feeds");

  const startFeedRes = await app.inject({
    method: "POST",
    url: "/api/v1/perception/feeds/cam1/start",
  });
  assert.equal(startFeedRes.statusCode, 200);
  assert.equal(calls[1]!.path, "/api/v1/feeds/cam1/start");

  await app.close();
});
