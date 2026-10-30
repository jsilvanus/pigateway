import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldStateAggregator } from '../src/world/world-state.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('WorldStateAggregator returns clean default state when no microservices are active', () => {
  const aggregator = new WorldStateAggregator();
  const state = aggregator.get();

  assert.ok(state);
  assert.ok(state.updatedAt);
  assert.equal(state.activeSpeaker.isSpeaking, false);
  assert.equal(state.activeSpeaker.source, 'none');
  assert.equal(state.activeSpeaker.person, null);
  assert.equal(state.spatial.available, false);
  assert.equal(state.spatial.subjectsCount, 0);
  assert.equal(state.audio.pivoiceAvailable, false);
  assert.equal(state.audio.pisoundAvailable, false);
  assert.equal(state.subsystems.pispace, false);
  assert.equal(state.subsystems.pivoice, false);
});

test('WorldStateAggregator fuses pivoice VAD and pispace 3D subject into active speaker', () => {
  let mockVoiceSpeaking = true;
  let mockSpatial: any = {
    updatedAt: new Date().toISOString(),
    activeZones: ['pulpit'],
    subjects: [
      {
        trackId: 1,
        sourceCameraId: 'cam1',
        position: { x: -3.5, y: 0.6, z: 1.3 },
        zoneId: 'pulpit',
        zoneName: 'Saarnastuoli (Pulpit)',
        confidence: 0.95,
        label: 'person',
      },
    ],
    cameras: {},
  };

  const aggregator = new WorldStateAggregator({
    getPiVoice: () => ({
      connected: true,
      stale: false,
      lastSeenAt: new Date().toISOString(),
      lastPollAt: null,
      sequence: 1,
      timestampMs: Date.now(),
      rmsDbfs: -18,
      peakDbfs: -12,
      classification: mockVoiceSpeaking ? 'speech' : 'silence',
      confidence: 0.96,
      capture: { state: 'running', sampleFormat: 'S16LE', channels: 1, sampleRateHz: 16000 },
      publisher: 'publishing',
    }),
    getSpatial: () => mockSpatial,
  });

  const fused = aggregator.compute();
  assert.equal(fused.activeSpeaker.isSpeaking, true);
  assert.equal(fused.activeSpeaker.source, 'fusion');
  assert.equal(fused.activeSpeaker.person?.zoneId, 'pulpit');
  assert.equal(fused.activeSpeaker.person?.trackId, 1);
  assert.ok(fused.activeSpeaker.confidence > 0.9);
  assert.equal(fused.spatial.available, true);
  assert.equal(fused.audio.pivoiceAvailable, true);
});

test('WorldStateAggregator gracefully handles voice with no spatial tracking', () => {
  const aggregator = new WorldStateAggregator({
    getPiVoice: () => ({
      connected: true,
      stale: false,
      lastSeenAt: new Date().toISOString(),
      lastPollAt: null,
      sequence: 1,
      timestampMs: Date.now(),
      rmsDbfs: -22,
      peakDbfs: -15,
      classification: 'speech',
      confidence: 0.88,
      capture: { state: 'running', sampleFormat: 'S16LE', channels: 1, sampleRateHz: 16000 },
      publisher: 'publishing',
    }),
    getSpatial: () => ({
      updatedAt: new Date(0).toISOString(),
      activeZones: [],
      subjects: [],
      cameras: {},
    }),
  });

  const state = aggregator.compute();
  assert.equal(state.activeSpeaker.isSpeaking, true);
  assert.equal(state.activeSpeaker.source, 'voice');
  assert.equal(state.activeSpeaker.person, null);
  assert.equal(state.spatial.available, false);
});

test('WorldStateAggregator identifies spatial subject poised at podium before speaking', () => {
  const aggregator = new WorldStateAggregator({
    getPiVoice: () => ({
      connected: true,
      stale: false,
      lastSeenAt: new Date().toISOString(),
      lastPollAt: null,
      sequence: 1,
      timestampMs: Date.now(),
      rmsDbfs: -60,
      peakDbfs: -55,
      classification: 'silence',
      confidence: 0.99,
      capture: { state: 'running', sampleFormat: 'S16LE', channels: 1, sampleRateHz: 16000 },
      publisher: 'publishing',
    }),
    getSpatial: () => ({
      updatedAt: new Date().toISOString(),
      activeZones: ['lectern'],
      subjects: [
        {
          trackId: 2,
          sourceCameraId: 'cam1',
          position: { x: 2.2, y: 0.5, z: 0.4 },
          zoneId: 'lectern',
          zoneName: 'Lukupulpetti (Lectern)',
          confidence: 0.92,
          label: 'person',
        },
      ],
      cameras: {},
    }),
  });

  const state = aggregator.compute();
  assert.equal(state.activeSpeaker.isSpeaking, false);
  assert.equal(state.activeSpeaker.source, 'spatial');
  assert.equal(state.activeSpeaker.person?.zoneId, 'lectern');
});

test('GET /api/v1/world-state endpoint returns world state from Fastify app', async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/world-state',
  });

  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.ok(data.updatedAt);
  assert.ok(data.activeSpeaker);
  assert.ok(data.subsystems);

  // Status also includes worldState
  const resStatus = await app.inject({
    method: 'GET',
    url: '/api/v1/status',
  });
  assert.equal(resStatus.statusCode, 200);
  assert.ok(resStatus.json().worldState);

  await app.close();
});
