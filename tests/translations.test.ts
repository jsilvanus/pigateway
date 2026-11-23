import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { TranscriptHub } from "../src/transcripts/transcript-hub.js";
import { parseTranslationId, TranslationHub } from "../src/transcripts/translation-hub.js";

const NOW = Date.parse("2026-10-28T16:00:10.000Z");
const START = Date.parse("2026-10-28T16:00:00.000Z");
const tr = (n: number, extra: Record<string, unknown> = {}) => ({
  sourceKey: `s1:${n}`, sourceSeq: n, session: "s1", source: "fi", lang: "en", text: ` Invented ${n} `,
  startMs: START, endMs: START + 2500, origin: "model", route: "mt", model: "m@1", latencyMs: 300, ...extra
});

test("hub validates, trims and numbers translations", () => {
  const hub = new TranslationHub({ now: () => NOW, epoch: "e1" });
  const result = hub.ingest([tr(1)]);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0], {
    epoch: "e1", seq: 1, sourceId: null, sourceKey: "s1:1", sourceSeq: 1, session: "s1", source: "fi", lang: "en",
    text: "Invented 1", startMs: START, endMs: START + 2500, origin: "model", route: "mt", model: "m@1", latencyMs: 300
  });
});

test("hub rejects bad entries without throwing and cuts long text", () => {
  const hub = new TranslationHub({ now: () => NOW });
  const result = hub.ingest([
    null, tr(1, { text: "" }), tr(2, { lang: "x!" }), tr(3, { lang: "fi" }), tr(4, { origin: "other" }),
    tr(5, { startMs: 1 }), tr(6, { sourceSeq: -1 }), tr(7, { sourceKey: "" }), tr(8, { text: "a".repeat(900) })
  ]);
  assert.equal(result.rejected.length, 8);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.text.length, 500);
});

test("hub de-duplicates on (sourceKey, lang)", () => {
  const hub = new TranslationHub({ now: () => NOW });
  hub.ingest([tr(1)]);
  const again = hub.ingest([tr(1), tr(1, { lang: "sv" }), tr(2)]);
  assert.equal(again.duplicates, 1);
  assert.equal(again.accepted.length, 2);
});

test("sourceId is resolved from the transcript ring", () => {
  const transcripts = new TranscriptHub({ now: () => NOW, epoch: "te" });
  transcripts.ingest("s1", [{ sequence: 5, text: "Aamen", language: "fi", wall_start: "2026-10-28T16:00:00Z" }]);
  const hub = new TranslationHub({ now: () => NOW, epoch: "e1", resolveSourceId: (s, n) => transcripts.resolveId(s, n) });
  const [first, second] = hub.ingest([tr(5), tr(6)]).accepted;
  assert.equal(first?.sourceId, "te:1");
  assert.equal(second?.sourceId, null);
});

test("transcripts that left the ring no longer resolve", () => {
  const transcripts = new TranscriptHub({ now: () => NOW, epoch: "te", capacity: 2 });
  for (let i = 1; i <= 4; i++) transcripts.ingest("s1", [{ sequence: i, text: `t${i}`, wall_start: "2026-10-28T16:00:00Z" }]);
  assert.equal(transcripts.resolveId("s1", 1), null);
  assert.equal(transcripts.resolveId("s1", 4), "te:4");
});

test("replay: same epoch only, bounded, ids are <epoch>:t<seq>", () => {
  const hub = new TranslationHub({ now: () => NOW, epoch: "e1", capacity: 3 });
  for (let i = 1; i <= 5; i++) hub.ingest([tr(i)]);
  assert.equal(hub.status().buffered, 3);
  assert.deepEqual(hub.since("e1:t3").map((e) => e.seq), [4, 5]);
  assert.deepEqual(hub.since("other:t3"), []);
  assert.deepEqual(hub.since("e1:3"), [], "a transcript id replays no translations");
  assert.deepEqual(parseTranslationId("e1:t7"), { epoch: "e1", seq: 7 });
  assert.equal(parseTranslationId("e1:7"), null);
});

test("POST /api/v1/translations accepts, de-duplicates and refuses bad bodies; GET catches up", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();
  const bad = await app.inject({ method: "POST", url: "/api/v1/translations", payload: {} });
  assert.equal(bad.statusCode, 400);
  const empty = await app.inject({ method: "POST", url: "/api/v1/translations", payload: { events: [{ text: "" }] } });
  assert.equal(empty.statusCode, 422);
  const now = Date.now();
  const event = tr(1, { startMs: now, endMs: now + 1000 });
  const ok = await app.inject({ method: "POST", url: "/api/v1/translations", payload: { events: [event] } });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.json().accepted, 1);
  const retry = await app.inject({ method: "POST", url: "/api/v1/translations", payload: { events: [event] } });
  assert.equal(retry.statusCode, 202);
  assert.equal(retry.json().duplicates, 1);
  const list = await app.inject({ method: "GET", url: "/api/v1/translations" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().translations, []);
  const epoch = list.json().epoch as string;
  const all = await app.inject({ method: "GET", url: `/api/v1/translations?after=${epoch}:t0` });
  assert.equal(all.json().translations.length, 1);
  await app.close();
});
