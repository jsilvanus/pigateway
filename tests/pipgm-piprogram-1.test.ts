import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPiPgmRoutes } from "../src/pipgm/pipgm-routes.js";
import { PiProgramClient } from "../src/pipgm/client.js";
import { findUiRoute } from "../src/ui/ui-listener.js";

type Seen = { method: string; path: string; search: string; contentType: string | null; body: unknown; raw?: Buffer };

/** Fake piprogram 1.0: records every call and answers JSON, PNG or zip-shaped bytes as the spec does. */
function fakeUpstream() {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = init?.body instanceof Buffer ? init.body : undefined;
    const contentType = new Headers(init?.headers).get("content-type");
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      contentType,
      body: raw ? undefined : init?.body ? JSON.parse(String(init.body)) : undefined,
      ...(raw ? { raw } : {})
    });
    if (url.pathname.endsWith("/frame.png")) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.pathname.endsWith("/tts/prepare")) {
      return new Response(JSON.stringify({ item: { id: "tts-1" }, cached: false }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/audio/play") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: { code: "AUDIO_NOT_ARMED", message: "Sound is not armed" } }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchFn };
}

async function appWith() {
  const { seen, fetchFn } = fakeUpstream();
  const app = Fastify();
  const client = new PiProgramClient({ baseUrl: "http://upstream-piprogram:3200/", token: "k", fetchFn });
  registerPiPgmRoutes(app, { client });
  return { app, seen };
}

test("writes and reads map to the piprogram 1.0 paths", async () => {
  const { app, seen } = await appWith();
  const calls: Array<[string, string, unknown?]> = [
    ["PUT", "/api/v1/pipgm/pipelines/PiPGM2/config", { orientation: "portrait" }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM2/control", { action: "gotoStep", stepIndex: 3 }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM2/ftb", { fadeToBlack: true, durationMs: 800 }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM2/audio", { audioEnabled: true, armSeconds: 600 }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM2/audio/stop"],
    ["POST", "/api/v1/pipgm/audio/kill"],
    ["PUT", "/api/v1/pipgm/pipelines/PiPGM2/basic-image", { itemId: "img-1" }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM2/playlist", { itemId: "h-1", cueImmediately: true }],
    ["DELETE", "/api/v1/pipgm/pipelines/PiPGM2/playlist/h-1"],
    ["GET", "/api/v1/pipgm/feeders"],
    ["GET", "/api/v1/pipgm/items/h-1/steps?orientation=portrait"],
    ["POST", "/api/v1/pipgm/items/h-1/prepare", { orientation: "landscape" }],
    ["PUT", "/api/v1/pipgm/items/h-1/use-at", { useAt: "2026-11-08" }],
    ["POST", "/api/v1/pipgm/items/youtube", { urlOrId: "abc" }],
    ["GET", "/api/v1/pipgm/library/storage"],
    ["GET", "/api/v1/pipgm/items?type=sound,tts&usedFrom=2026-11-22&limit=20"],
    ["PATCH", "/api/v1/pipgm/items/h-1", { type: "song" }],
    ["GET", "/api/v1/pipgm/library/active?date=2026-11-22"],
    ["PUT", "/api/v1/pipgm/library/active/h-1"],
    ["DELETE", "/api/v1/pipgm/library/active/h-1"],
    ["DELETE", "/api/v1/pipgm/library/active"],
    ["POST", "/api/v1/pipgm/library/active/playlist", { name: "Sunday" }],
    ["GET", "/api/v1/pipgm/tasks/t-1"]
  ];
  for (const [method, url, payload] of calls) {
    const res = await app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    assert.equal(res.statusCode, 200, `${method} ${url} -> ${res.body}`);
  }
  assert.deepEqual(
    seen.map((c) => `${c.method} ${c.path}${c.search}`),
    [
      "PUT /api/v1/pipgm/pipelines/PiPGM2/config",
      "POST /api/v1/pipgm/pipelines/PiPGM2/control",
      "POST /api/v1/pipgm/pipelines/PiPGM2/ftb",
      "POST /api/v1/pipgm/pipelines/PiPGM2/audio",
      "POST /api/v1/pipgm/pipelines/PiPGM2/audio/stop",
      "POST /api/v1/pipgm/audio/kill",
      "PUT /api/v1/pipgm/pipelines/PiPGM2/basic-image",
      "POST /api/v1/pipgm/pipelines/PiPGM2/playlist",
      "DELETE /api/v1/pipgm/pipelines/PiPGM2/playlist/h-1",
      "GET /api/v1/pipgm/feeders",
      "GET /api/v1/pipgm/items/h-1/steps?orientation=portrait",
      "POST /api/v1/pipgm/items/h-1/prepare",
      "PUT /api/v1/pipgm/items/h-1/use-at",
      "POST /api/v1/pipgm/items/youtube",
      "GET /api/v1/pipgm/library/storage",
      "GET /api/v1/pipgm/items?type=sound%2Ctts&usedFrom=2026-11-22&limit=20",
      "PATCH /api/v1/pipgm/items/h-1",
      "GET /api/v1/pipgm/library/active?date=2026-11-22",
      "PUT /api/v1/pipgm/library/active/h-1",
      "DELETE /api/v1/pipgm/library/active/h-1",
      "DELETE /api/v1/pipgm/library/active",
      "POST /api/v1/pipgm/library/active/playlist",
      "GET /api/v1/pipgm/tasks/t-1"
    ]
  );
  assert.equal(seen[1]?.body && (seen[1].body as { action: string }).action, "gotoStep");
  await app.close();
});

test("legacy /step, /play, /pause and /cue become piprogram control actions", async () => {
  const { app, seen } = await appWith();
  await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/step" });
  await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/play" });
  await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/pause" });
  await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/cue", payload: { itemId: "h-9" } });
  assert.deepEqual(
    seen.map((c) => (c.body as { action: string }).action),
    ["next", "play", "pause", "gotoItem"]
  );
  const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/cue", payload: {} });
  assert.equal(bad.statusCode, 422);
  await app.close();
});

test("frame.png and asset answers keep their bytes and content type", async () => {
  const { app } = await appWith();
  const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?width=640&alpha=1" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.deepEqual([...res.rawPayload], [0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  await app.close();
});

test("upstream errors keep piprogram's error code and status", async () => {
  const { app } = await appWith();
  const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio/play", payload: { itemId: "x" } });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error.code, "AUDIO_NOT_ARMED");
  await app.close();
});

test("a Canva zip is passed on as application/zip, JSON as JSON", async () => {
  const { app, seen } = await appWith();
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/items/c-1/canva/export-package?orientation=landscape,portrait",
    headers: { "content-type": "application/zip" },
    payload: zip
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0]?.search, "?orientation=landscape%2Cportrait");
  assert.equal(seen[0]?.contentType, "application/zip");
  assert.deepEqual(seen[0]?.raw, zip);

  const json = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/items/c-1/canva/export-package",
    payload: { pages: [{ filename: "1.png", dataBase64: "AA==" }] }
  });
  assert.equal(json.statusCode, 200);
  assert.equal(seen[1]?.contentType, "application/json");
  assert.deepEqual(seen[1]?.body, { pages: [{ filename: "1.png", dataBase64: "AA==" }] });
  await app.close();
});

test("the relay gets reads, control, ftb, playlist and audio kill/stop; LAN-only setup stays off it", () => {
  const relay = (method: string, url: string) => {
    const rule = findUiRoute(method, url);
    return rule !== null && !rule.setup;
  };
  // relay: allowed
  assert.ok(relay("GET", "/api/v1/pipgm/pipelines/PiPGM1/frame.png"));
  assert.ok(relay("GET", "/api/v1/pipgm/items/h-1/steps/2/thumbnail.jpg"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/control"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/ftb"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/playlist"));
  assert.ok(relay("DELETE", "/api/v1/pipgm/pipelines/PiPGM1/playlist/h-1"));
  assert.ok(relay("POST", "/api/v1/pipgm/audio/kill"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/audio/stop"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/step"));
  // relay: LAN only
  assert.equal(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/audio"), false);
  assert.equal(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/audio/play"), false);
  assert.equal(relay("POST", "/api/v1/pipgm/tts/prepare"), false);
  assert.equal(relay("PUT", "/api/v1/pipgm/pipelines/PiPGM1/config"), false);
  assert.equal(relay("PUT", "/api/v1/pipgm/pipelines/PiPGM1/basic-image"), false);
  // adding content works from outside the church network too (decision of 2026-11-19)
  for (const [m, u] of [["POST", "/api/v1/pipgm/items/hymn"], ["POST", "/api/v1/pipgm/items/youtube"], ["POST", "/api/v1/pipgm/items/media"], ["POST", "/api/v1/pipgm/items/pptx"], ["POST", "/api/v1/pipgm/items/canva"], ["PUT", "/api/v1/pipgm/items/h-1/use-at"], ["POST", "/api/v1/pipgm/items/h-1/prepare"], ["POST", "/api/v1/pipgm/items/h-1/canva/export-package"]] as const) {
    assert.ok(relay(m, u), `${m} ${u}`);
  }
  assert.equal(relay("DELETE", "/api/v1/pipgm/items/h-1"), false);
  // generic library: filters, type edits, active folder and a playlist from it work through the relay; clearing it does not
  for (const [m, u] of [["GET", "/api/v1/pipgm/items"], ["PATCH", "/api/v1/pipgm/items/h-1"], ["GET", "/api/v1/pipgm/library/active"], ["PUT", "/api/v1/pipgm/library/active/h-1"], ["DELETE", "/api/v1/pipgm/library/active/h-1"], ["POST", "/api/v1/pipgm/library/active/playlist"]] as const) {
    assert.ok(relay(m, u), `${m} ${u}`);
  }
  assert.equal(relay("DELETE", "/api/v1/pipgm/library/active"), false);
});

test("without a configured piprogram the routes answer 503", async () => {
  const app = Fastify();
  registerPiPgmRoutes(app, { client: new PiProgramClient({}) });
  const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/feeders" });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("playlist routes map to the piprogram playlist API", async () => {
  const { app, seen } = await appWith();
  const calls: Array<[string, string, unknown?]> = [
    ["GET", "/api/v1/pipgm/pipelines/PiPGM1/playlist/steps"],
    ["PUT", "/api/v1/pipgm/pipelines/PiPGM1/playlist/order", { itemIds: ["b", "a"] }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM1/playlist/load", { playlistId: "pl_1", mode: "append" }],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM1/playlist/save", { name: "Sunday" }],
    ["GET", "/api/v1/pipgm/playlists"],
    ["POST", "/api/v1/pipgm/playlists", { schema: "piprogram.playlist/1", name: "x", items: [] }],
    ["POST", "/api/v1/pipgm/playlists/generate", { date: "2026-11-22" }],
    ["GET", "/api/v1/pipgm/playlists/pl_1"],
    ["PUT", "/api/v1/pipgm/playlists/pl_1", { schema: "piprogram.playlist/1", name: "y", items: [] }],
    ["DELETE", "/api/v1/pipgm/playlists/pl_1"]
  ];
  for (const [method, url, payload] of calls) {
    const res = await app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    assert.equal(res.statusCode, 200, `${method} ${url} -> ${res.body}`);
  }
  assert.deepEqual(
    seen.map((c) => `${c.method} ${c.path}`),
    calls.map(([m, u]) => `${m} ${u}`)
  );
  assert.deepEqual(seen[1]?.body, { itemIds: ["b", "a"] });
  assert.deepEqual(seen[2]?.body, { playlistId: "pl_1", mode: "append" });
  await app.close();
});

test("relay: playlists may be read and loaded; content, saving, reordering and generating are allowed; deleting is LAN only", () => {
  const rule = (method: string, url: string) => findUiRoute(method, url);
  const relay = (method: string, url: string) => {
    const r = rule(method, url);
    return r !== null && !r.setup;
  };
  // relay: allowed
  assert.ok(relay("GET", "/api/v1/pipgm/pipelines/PiPGM1/playlist/steps"));
  assert.ok(relay("GET", "/api/v1/pipgm/playlists"));
  assert.ok(relay("GET", "/api/v1/pipgm/playlists/pl_1"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/playlist/load"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/control"));
  assert.ok(relay("POST", "/api/v1/pipgm/audio/kill"));
  assert.ok(relay("POST", "/api/v1/pipgm/pipelines/PiPGM1/audio/stop"));
  for (const [m, u] of [
    ["PUT", "/api/v1/pipgm/pipelines/PiPGM1/playlist/order"],
    ["POST", "/api/v1/pipgm/pipelines/PiPGM1/playlist/save"],
    ["POST", "/api/v1/pipgm/playlists"],
    ["POST", "/api/v1/pipgm/playlists/generate"],
    ["PUT", "/api/v1/pipgm/playlists/pl_1"]
  ] as const) assert.ok(relay(m, u), `${m} ${u}`);
  // destructive: LAN only
  const del = rule("DELETE", "/api/v1/pipgm/playlists/pl_1");
  assert.ok(del);
  assert.equal(del.setup, true);
  // wrong method or unknown path stays off the allowlist
  assert.equal(rule("DELETE", "/api/v1/pipgm/playlists"), null);
  assert.equal(rule("PUT", "/api/v1/pipgm/playlists"), null);
  assert.equal(rule("GET", "/api/v1/pipgm/pipelines/PiPGM1/playlist/save"), null);
  assert.equal(rule("GET", "/api/v1/pipgm/pipelines/PiPGM1/playlist/order"), null);
});
