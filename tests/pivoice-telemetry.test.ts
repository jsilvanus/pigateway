import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { decodePiVoicePacket, PiVoiceUdpReceiver, PIVOICE_PACKET_BYTES } from "../src/pivoice/telemetry.js";

function packet(): Buffer {
  const out = Buffer.alloc(PIVOICE_PACKET_BYTES);
  out.write("PV", 0, "ascii");
  out.writeUInt8(1, 2);
  out.writeUInt8(1, 3);
  out.writeUInt16BE(0, 4);
  out.writeUInt16BE(22, 6);
  out.writeUInt32BE(123, 8);
  out.writeBigUInt64BE(1_761_600_000_123n, 12);
  out.writeInt32BE(-42125, 20);
  out.writeInt32BE(-3500, 24);
  out.writeUInt8(2, 28);
  out.writeUInt8(100, 29);
  out.writeUInt8(1, 30);
  out.writeUInt8(0, 31);
  out.writeUInt16BE(1, 32);
  out.writeUInt32BE(48000, 34);
  out.writeUInt8(1, 38);
  return out;
}

test("decodes the fixed binary snapshot", () => {
  const decoded = decodePiVoicePacket(packet());
  assert.deepEqual(decoded, {
    sequence: 123,
    timestampMs: 1_761_600_000_123,
    rmsDbfs: -42.125,
    peakDbfs: -3.5,
    classification: "speech",
    confidence: 100,
    capture: { state: "running", sampleFormat: "unknown", channels: 1, sampleRateHz: 48000 },
    publisher: "publishing"
  });
});

test("rejects malformed or unsupported packets", () => {
  const valid = packet();
  assert.equal(decodePiVoicePacket(valid.subarray(0, valid.length - 1)), null);
  const badMagic = packet();
  badMagic.write("XX", 0, "ascii");
  assert.equal(decodePiVoicePacket(badMagic), null);
  const badLength = packet();
  badLength.writeUInt16BE(28, 6);
  assert.equal(decodePiVoicePacket(badLength), null);
  const badClassification = packet();
  badClassification.writeUInt8(9, 28);
  assert.equal(decodePiVoicePacket(badClassification), null);
});

test("receiver stores valid telemetry, rejects other senders, and marks state stale", async () => {
  let now = 1_761_600_000_000;
  const changes: Array<{ stale: boolean; classification: string }> = [];
  const receiver = new PiVoiceUdpReceiver({
    host: "127.0.0.1",
    port: 0,
    allowedIps: ["127.0.0.1"],
    staleMs: 100,
    now: () => now,
    onChange: (state) => changes.push({ stale: state.stale, classification: state.classification })
  });
  const sender = dgram.createSocket("udp4");
  try {
    await receiver.start();
    const send = () => new Promise<void>((resolve, reject) => {
      sender.send(packet(), receiver.getBoundPort(), "127.0.0.1", (error) => error ? reject(error) : resolve());
    });
    await send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(receiver.getState().connected, true);
    assert.equal(receiver.getState().classification, "speech");
    assert.equal(receiver.getState().rmsDbfs, -42.125);
    assert.equal(changes[0]?.classification, "speech");
    now += 101;
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(receiver.getState().stale, true);
    assert.ok(changes.some((change) => change.stale));
  } finally {
    sender.close();
    await receiver.stop();
  }
});


test("gateway status exposes initial PiVoice telemetry state for UI clients", async () => {
  const { buildApp } = await import("../src/app.js");
  const { loadConfig } = await import("../src/config.js");
  const app = buildApp({ ...loadConfig({}), pivoiceUdpPort: 0 });
  try {
    await app.ready();
    const response = await app.inject({ url: "/api/v1/status" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().pivoice.connected, false);
    assert.equal(response.json().pivoice.stale, true);
    assert.equal(response.json().pivoice.classification, "unknown");
  } finally {
    await app.close();
  }
});
