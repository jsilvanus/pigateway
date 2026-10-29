import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import {
  decodePiSoundPacket,
  PiSoundUdpReceiver,
  PISOUND_MAGIC,
  PISOUND_VERSION,
  PISOUND_TYPE_SNAPSHOT
} from "../src/pisound/telemetry.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function buildTestPacket(options: {
  sequence?: number;
  timestampMs?: number;
  activeTalkersMask?: number;
  mixes?: Array<{ id: string; controlType: "gain" | "toggle"; masterVolume: number; masterMuted: boolean }>;
  channels?: Array<{
    channelIndex: number;
    peakMilliDbfs: number;
    profileCode: number;
    signalPresent: boolean;
    agcActive: boolean;
    isOn: boolean;
    sends: Array<{ enabled: boolean; volumePercent: number }>;
  }>;
} = {}): Buffer {
  const sequence = options.sequence ?? 42;
  const timestampMs = options.timestampMs ?? 1_761_600_000_000;
  const activeTalkersMask = options.activeTalkersMask ?? 0x05; // channels 0 & 2
  const mixes = options.mixes ?? [
    { id: "sali", controlType: "gain", masterVolume: 80, masterMuted: false },
    { id: "striimi", controlType: "gain", masterVolume: 75, masterMuted: false }
  ];
  const channels = options.channels ?? [
    {
      channelIndex: 0,
      peakMilliDbfs: -18000,
      profileCode: 0, // speech
      signalPresent: true,
      agcActive: false,
      isOn: true,
      sends: [
        { enabled: true, volumePercent: 78 },
        { enabled: true, volumePercent: 70 }
      ]
    },
    {
      channelIndex: 1,
      peakMilliDbfs: -60000,
      profileCode: 1, // vocal
      signalPresent: false,
      agcActive: false,
      isOn: false,
      sends: [
        { enabled: false, volumePercent: 0 },
        { enabled: true, volumePercent: 65 }
      ]
    }
  ];

  let size = 24;
  const mixIdBufs = mixes.map((m) => Buffer.from(m.id, "utf8"));
  for (const b of mixIdBufs) {
    size += 1 + b.length + 3;
  }
  size += channels.length * (1 + 4 + 1 + 1 + mixes.length);

  const buf = Buffer.alloc(size);
  let offset = 0;

  // Header (24 bytes)
  buf.writeUInt16BE(PISOUND_MAGIC, offset);
  offset += 2;
  buf.writeUInt8(PISOUND_VERSION, offset);
  offset += 1;
  buf.writeUInt8(PISOUND_TYPE_SNAPSHOT, offset);
  offset += 1;
  buf.writeUInt16BE(0, offset); // Flags
  offset += 2;
  buf.writeUInt32BE(sequence, offset);
  offset += 4;
  buf.writeBigUInt64BE(BigInt(timestampMs), offset);
  offset += 8;
  buf.writeUInt8(mixes.length, offset);
  offset += 1;
  buf.writeUInt8(channels.length, offset);
  offset += 1;
  buf.writeUInt32BE(activeTalkersMask, offset);
  offset += 4;

  // Mixes
  for (let i = 0; i < mixes.length; i++) {
    const m = mixes[i]!;
    const idB = mixIdBufs[i]!;
    buf.writeUInt8(idB.length, offset);
    offset += 1;
    idB.copy(buf, offset);
    offset += idB.length;
    buf.writeUInt8(m.controlType === "gain" ? 1 : 0, offset);
    offset += 1;
    buf.writeUInt8(m.masterVolume, offset);
    offset += 1;
    buf.writeUInt8(m.masterMuted ? 1 : 0, offset);
    offset += 1;
  }

  // Channels
  for (const ch of channels) {
    buf.writeUInt8(ch.channelIndex, offset);
    offset += 1;
    buf.writeInt32BE(ch.peakMilliDbfs, offset);
    offset += 4;
    buf.writeUInt8(ch.profileCode, offset);
    offset += 1;
    let flags = 0;
    if (ch.signalPresent) flags |= 0x01;
    if (ch.agcActive) flags |= 0x02;
    if (ch.isOn) flags |= 0x04;
    buf.writeUInt8(flags, offset);
    offset += 1;

    for (let i = 0; i < mixes.length; i++) {
      const send = ch.sends[i]!;
      let sendByte = send.volumePercent & 0x7f;
      if (send.enabled) sendByte |= 0x80;
      buf.writeUInt8(sendByte, offset);
      offset += 1;
    }
  }

  return buf;
}

test("decodes valid PiSound binary telemetry snapshot", () => {
  const packet = buildTestPacket();
  const decoded = decodePiSoundPacket(packet);
  assert.ok(decoded);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.timestampMs, 1_761_600_000_000);
  assert.equal(decoded.activeTalkersMask, 5);
  assert.equal(decoded.mixes.length, 2);
  assert.equal(decoded.mixes[0]?.id, "sali");
  assert.equal(decoded.mixes[0]?.controlType, "gain");
  assert.equal(decoded.mixes[0]?.masterVolume, 80);
  assert.equal(decoded.mixes[0]?.masterMuted, false);
  assert.equal(decoded.mixes[1]?.id, "striimi");

  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.channels[0]?.channelIndex, 0);
  assert.equal(decoded.channels[0]?.peakMilliDbfs, -18000);
  assert.equal(decoded.channels[0]?.profile, "speech");
  assert.equal(decoded.channels[0]?.signalPresent, true);
  assert.equal(decoded.channels[0]?.isOn, true);
  assert.equal(decoded.channels[0]?.mixSends["sali"]?.enabled, true);
  assert.equal(decoded.channels[0]?.mixSends["sali"]?.volumePercent, 78);
  assert.equal(decoded.channels[0]?.mixSends["striimi"]?.enabled, true);
  assert.equal(decoded.channels[0]?.mixSends["striimi"]?.volumePercent, 70);

  assert.equal(decoded.channels[1]?.channelIndex, 1);
  assert.equal(decoded.channels[1]?.profile, "vocal");
  assert.equal(decoded.channels[1]?.signalPresent, false);
  assert.equal(decoded.channels[1]?.isOn, false);
  assert.equal(decoded.channels[1]?.mixSends["sali"]?.enabled, false);
  assert.equal(decoded.channels[1]?.mixSends["striimi"]?.enabled, true);
});

test("rejects truncated or malformed PiSound packets", () => {
  const valid = buildTestPacket();
  assert.equal(decodePiSoundPacket(valid.subarray(0, 10)), null);

  const badMagic = Buffer.from(valid);
  badMagic.writeUInt16BE(0x1234, 0);
  assert.equal(decodePiSoundPacket(badMagic), null);

  const badVersion = Buffer.from(valid);
  badVersion.writeUInt8(99, 2);
  assert.equal(decodePiSoundPacket(badVersion), null);
});

test("PiSoundUdpReceiver captures packets, updates state, and marks stale", async () => {
  let now = 1_761_600_000_000;
  const changes: Array<{ connected: boolean; stale: boolean; seq: number | null }> = [];
  const receiver = new PiSoundUdpReceiver({
    host: "127.0.0.1",
    port: 0,
    staleMs: 80,
    now: () => now,
    onChange: (state) => changes.push({ connected: state.connected, stale: state.stale, seq: state.sequence })
  });

  const sender = dgram.createSocket("udp4");
  try {
    await receiver.start();
    const port = receiver.getBoundPort();

    // Initially disconnected and stale
    assert.equal(receiver.getState().connected, false);
    assert.equal(receiver.getState().stale, true);

    // Send packet
    const p1 = buildTestPacket({ sequence: 101 });
    await new Promise<void>((resolve, reject) => {
      sender.send(p1, port, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(receiver.getState().connected, true);
    assert.equal(receiver.getState().stale, false);
    assert.equal(receiver.getState().sequence, 101);
    assert.equal(changes.length >= 1, true);

    // Advance time beyond staleMs
    now += 150;
    assert.equal(receiver.getState().connected, false);
    assert.equal(receiver.getState().stale, true);
  } finally {
    await receiver.stop();
    sender.close();
  }
});

test("app serves GET /api/v1/sound and includes pisound in GET /api/v1/status", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_PISOUND_UDP_PORT: "0", PIGATEWAY_PIVOICE_UDP_PORT: "0" }));
  await app.ready();

  const soundRes = await app.inject({ method: "GET", url: "/api/v1/sound" });
  assert.equal(soundRes.statusCode, 200);
  const soundData = soundRes.json();
  assert.equal(soundData.connected, false);
  assert.equal(soundData.stale, true);

  const statusRes = await app.inject({ method: "GET", url: "/api/v1/status" });
  assert.equal(statusRes.statusCode, 200);
  const statusData = statusRes.json();
  assert.ok(statusData.pisound);
  assert.equal(statusData.pisound.connected, false);

  await app.close();
});
