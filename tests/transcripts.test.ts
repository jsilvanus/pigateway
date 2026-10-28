import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { PiVoiceActivityCoordinator } from "../src/pivoice/activity-coordinator.js";
import type { PiVoiceTelemetry } from "../src/pivoice/telemetry.js";
import { AuditorSseSource } from "../src/transcripts/auditor-sse-source.js";
import { parseTranscriptId, TranscriptHub } from "../src/transcripts/transcript-hub.js";

const NOW = Date.parse("2026-10-28T16:00:10.000Z");
const wire = (sequence: number, text: string, extra: Record<string, unknown> = {}) => ({
  sequence, text, language: "fi", wall_start: "2026-10-28T16:00:00.000Z", wall_end: "2026-10-28T16:00:02.500Z", ...extra
});

test("hub normalises auditor transcripts to epoch-ms audio times and numbers them", () => {
  const hub = new TranscriptHub({ now: () => NOW, epoch: "e1" });
  const result = hub.ingest("s1", [wire(1, "  Herra olkoon  ")]);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0], {
    epoch: "e1", seq: 1, session: "s1", language: "fi", text: "Herra olkoon",
    startedAt: Date.parse("2026-10-28T16:00:00.000Z"), endedAt: Date.parse("2026-10-28T16:00:02.500Z"), source: "auditor"
  });
});

test("hub drops duplicates per session, reports bad entries and never throws", () => {
  const hub = new TranscriptHub({ now: () => NOW });
  hub.ingest("s1", [wire(1, "a")]);
  const again = hub.ingest("s1", [wire(1, "a"), wire(2, "b"), { text: "" }, null, wire(3, "x", { wall_start: "2000-01-01T00:00:00Z" })]);
  assert.equal(again.duplicates, 1);
  assert.equal(again.accepted.length, 1);
  assert.equal(again.rejected.length, 3);
  assert.equal(hub.ingest("s2", [wire(1, "a")]).accepted.length, 1, "same sequence in another session is new");
});

test("hub replays only same-epoch transcripts after the given id and is bounded", () => {
  const hub = new TranscriptHub({ now: () => NOW, epoch: "e1", capacity: 10 });
  for (let i = 1; i <= 15; i++) hub.ingest("s", [wire(i, `t${i}`)]);
  assert.equal(hub.status().buffered, 10);
  assert.deepEqual(hub.since("e1:12").map((e) => e.seq), [13, 14, 15]);
  assert.deepEqual(hub.since("other:12"), []);
  assert.deepEqual(hub.since(undefined), []);
  assert.deepEqual(parseTranscriptId("e1:7"), { epoch: "e1", seq: 7 });
  assert.equal(parseTranscriptId("nonsense"), null);
});

test("POST /api/v1/transcripts accepts pushes, GET catches up, bad bodies are refused", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();
  const bad = await app.inject({ method: "POST", url: "/api/v1/transcripts", payload: { session_id: "s" } });
  assert.equal(bad.statusCode, 400);
  const empty = await app.inject({ method: "POST", url: "/api/v1/transcripts", payload: { session_id: "s", events: [{ text: "" }] } });
  assert.equal(empty.statusCode, 422);
  const startedAt = new Date().toISOString();
  const ok = await app.inject({ method: "POST", url: "/api/v1/transcripts", payload: { session_id: "s", events: [{ sequence: 1, text: "Aamen", language: "fi", wall_start: startedAt, wall_end: startedAt }] } });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.json().accepted, 1);
  const retry = await app.inject({ method: "POST", url: "/api/v1/transcripts", payload: { session_id: "s", events: [{ sequence: 1, text: "Aamen", language: "fi", wall_start: startedAt }] } });
  assert.equal(retry.statusCode, 202);
  assert.equal(retry.json().duplicates, 1);
  const first = await app.inject({ method: "GET", url: "/api/v1/transcripts" });
  const { epoch } = first.json();
  const list = await app.inject({ method: "GET", url: `/api/v1/transcripts?after=${epoch}:0` });
  assert.equal(list.json().transcripts.length, 1);
  assert.equal(list.json().transcripts[0].text, "Aamen");
  await app.close();
});

test("transcript pushes need the API key when one is configured", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_API_KEY: "secret" }));
  await app.ready();
  const payload = { session_id: "s", events: [{ text: "x", wall_start: new Date().toISOString() }] };
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/transcripts", payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/transcripts", payload, headers: { authorization: "Bearer secret" } })).statusCode, 202);
  await app.close();
});

test("SSE stream carries transcript ids, filters by types and replays after Last-Event-ID", async () => {
  const app = buildApp(loadConfig({}));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const push = (sequence: number, text: string) => fetch(`${base}/api/v1/transcripts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "s", events: [{ sequence, text, language: "fi", wall_start: new Date().toISOString() }] })
  });
  await push(1, "yksi");
  await push(2, "kaksi");
  const { epoch } = await (await fetch(`${base}/api/v1/transcripts`)).json();

  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/events?types=transcript`, { headers: { "last-event-id": `${epoch}:1` }, signal: abort.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  let text = "";
  const read = async (until: RegExp) => {
    while (!until.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  };
  await read(/kaksi/);
  assert.ok(text.includes(`id: ${epoch}:2\nevent: transcript`), "replayed transcript has its id");
  assert.ok(!text.includes("yksi"), "already seen transcript is not replayed");
  await push(3, "kolme");
  await read(/kolme/);
  assert.ok(text.includes(`id: ${epoch}:3\n`));
  assert.ok(!text.includes("event: pivoice"), "other types are filtered out");
  abort.abort();
  await app.close();
});

function sseResponse(chunks: string[], hold?: Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (hold) await hold;
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("auditor SSE source feeds the hub, resumes with Last-Event-ID and stops cleanly", async () => {
  const hub = new TranscriptHub({ now: () => Date.now() });
  const now = new Date().toISOString();
  const event = (id: number, text: string) => `id: ${id}\nevent: transcript\ndata: ${JSON.stringify({ sequence: id, text, language: "fi", wall_start: now, wall_end: now })}\n\n`;
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let calls = 0;
  const source = new AuditorSseSource({
    baseUrl: "http://auditor:8080/", apiKey: "k", hub, minBackoffMs: 5, maxBackoffMs: 10,
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      calls++;
      // First connection: an event split across chunks, then the stream drops.
      if (calls === 1) return sseResponse([event(1, "yksi").slice(0, 25), event(1, "yksi").slice(25), "event: status\ndata: {}\n\n"]);
      return sseResponse([event(2, "kaksi")], new Promise(() => undefined));
    }
  });
  source.start("sess 1");
  for (let i = 0; i < 100 && hub.status().accepted < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(hub.since(`${hub.epoch}:0`).map((e) => e.text), ["yksi", "kaksi"]);
  assert.equal(seen[0]!.url, "http://auditor:8080/v1/live/sess%201/events");
  assert.equal(seen[0]!.headers.authorization, "Bearer k");
  assert.equal(seen[1]!.headers["last-event-id"], "1");
  assert.ok(source.status().reconnects >= 1);
  source.stop();
  assert.equal(source.status().session, null);
});

test("auditor SSE source gives up when the session is gone", async () => {
  const hub = new TranscriptHub();
  let calls = 0;
  const source = new AuditorSseSource({ baseUrl: "http://a", hub, minBackoffMs: 1, fetchFn: async () => { calls++; return new Response("", { status: 404 }); } });
  source.start("gone");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  source.stop();
});

test("coordinator asks PiVoice for the configured delivery and reports the session id", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const sessions: Array<string | null> = [];
  const coordinator = new PiVoiceActivityCoordinator({
    baseUrl: "http://pivoice:8095", idleCloseSeconds: 0,
    delivery: { mode: "push", url: "https://gw/api/v1/transcripts", token: "t" },
    onSession: (id) => sessions.push(id),
    fetchFn: async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(String(url).endsWith("/start") ? { sessionId: "live_1", running: true } : {}), { status: 200 });
    }
  });
  const telemetry = (classification: PiVoiceTelemetry["classification"]): PiVoiceTelemetry => ({
    connected: true, stale: false, lastSeenAt: new Date().toISOString(), lastPollAt: null, sequence: 1, timestampMs: Date.now(),
    rmsDbfs: -30, peakDbfs: -10, classification, confidence: 90,
    capture: { state: "running", sampleFormat: "S16LE", channels: 1, sampleRateHz: 16000 }, publisher: "publishing"
  });
  coordinator.observe(telemetry("speech"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bodies[0], { trigger: "speech", delivery: { mode: "push", url: "https://gw/api/v1/transcripts", token: "t" } });
  assert.deepEqual(sessions, ["live_1"]);
  await coordinator.close();
  assert.deepEqual(sessions, ["live_1", null]);
});

test("config validates transcript delivery settings", () => {
  assert.equal(loadConfig({}).transcriptDelivery, "sse");
  assert.equal(loadConfig({ PIGATEWAY_TRANSCRIPT_DELIVERY: "push", PIGATEWAY_API_KEY: "k" }).transcriptPushToken, "k");
  assert.throws(() => loadConfig({ PIGATEWAY_TRANSCRIPT_DELIVERY: "carrier-pigeon" }), /sse or push/);
  assert.throws(() => loadConfig({ PIGATEWAY_AUDITOR_URL: "ftp://x" }), /PIGATEWAY_AUDITOR_URL/);
});
