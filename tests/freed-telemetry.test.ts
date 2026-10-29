import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import {
  decodeFreedPacket,
  encodeFreedPacket,
  verifyFreedChecksum,
  FreedUdpReceiver
} from "../src/camera/freed-receiver.js";
import { GatewayEventBroker } from "../src/events.js";

test("FreeD encoding and decoding works with checksum verification", () => {
  const packet = encodeFreedPacket({
    camId: 1,
    panDeg: 45.5,
    tiltDeg: -12.25,
    rollDeg: 0,
    xMm: 1200,
    yMm: -350,
    zMm: 1800,
    zoom: 50000,
    focus: 12000
  });

  assert.equal(packet.length, 29);
  assert.equal(verifyFreedChecksum(packet), true);

  const decoded = decodeFreedPacket(packet);
  assert.ok(decoded);
  assert.equal(decoded.camId, 1);
  assert.equal(decoded.pan, 45.5);
  assert.equal(decoded.tilt, -12.25);
  assert.equal(decoded.x, 1200);
  assert.equal(decoded.y, -350);
  assert.equal(decoded.z, 1800);
  assert.equal(decoded.zoom, 50000);
  assert.equal(decoded.focus, 12000);
});

test("FreedUdpReceiver receives datagrams and emits SSE events", async (t) => {
  const eventBroker = new GatewayEventBroker();
  const receiver = new FreedUdpReceiver({
    host: "127.0.0.1",
    port: 0, // ephemeral port
    eventBroker
  });

  await receiver.start();
  t.after(async () => {
    await receiver.stop();
  });

  const boundPort = receiver.getBoundPort();
  assert.ok(boundPort > 0);

  const events: any[] = [];
  const unsubscribe = eventBroker.subscribe((event) => {
    if (event.type === "freed") {
      events.push(event.data);
    }
  });
  t.after(() => unsubscribe());

  // Send a test packet
  const packet = encodeFreedPacket({
    camId: 2,
    panDeg: 90.0,
    tiltDeg: 5.0,
    zoom: 12345
  });

  const client = dgram.createSocket("udp4");
  t.after(() => client.close());

  await new Promise<void>((resolve, reject) => {
    client.send(packet, boundPort, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Wait briefly for socket message event
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.camId, 2);
  assert.equal(events[0]?.pan, 90.0);

  const cached = receiver.getTelemetry(2);
  assert.ok(cached);
  assert.equal(cached.pan, 90.0);
});
