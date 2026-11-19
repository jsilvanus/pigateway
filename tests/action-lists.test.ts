import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ActionRegistry } from "../src/actions/action-registry.js";
import { ActionListStore, routesProjector, validateCreate } from "../src/actions/action-lists.js";
import { registerActionListRoutes } from "../src/actions/action-list-routes.js";
import { registerCanvaRoutes } from "../src/canva/canva-routes.js";
import { CanvaService } from "../src/canva/canva-service.js";
import { PiProgramClient } from "../src/pipgm/client.js";
import { PiMatrixClient } from "../src/matrix/client.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildUiListener, createOpenAuth, findUiRoute } from "../src/ui/ui-listener.js";
import { createUiForward } from "../src/ui/ui-setup.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return quiet; }, level: "silent" } as never;

type Call = { target: "piprogram" | "pimatrix"; method: string; path: string; body: unknown };

/** A fake piprogram and pimatrix that record every call. A path listed in `fail` answers 500. */
function upstreams(fail: string[] = []) {
  const calls: Call[] = [];
  const make = (target: Call["target"]): typeof fetch => async (input, init) => {
    const url = new URL(String(input));
    calls.push({ target, method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (fail.some((p) => url.pathname.endsWith(p))) {
      return new Response(JSON.stringify({ error: { code: "BOOM", message: "upstream broke" } }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, path: url.pathname }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const pipgm = new PiProgramClient({ baseUrl: "http://piprogram:3200", token: "k", fetchFn: make("piprogram") });
  const pimatrix = new PiMatrixClient({ baseUrl: "http://pimatrix:3101", fetchFn: make("pimatrix") });
  return { calls, pipgm, pimatrix };
}

function makeRegistry(up: ReturnType<typeof upstreams>) {
  return new ActionRegistry({
    config: loadConfig({ PIGATEWAY_MODE: "simulation" }),
    atem: { getState: () => ({ connected: false }) } as never,
    cameraService: undefined as never,
    encoder: undefined as never,
    matrix: { route: async () => ({ success: true }) } as never,
    ecosystemTracker: { getSummary: () => ({ components: {} }) } as never,
    eventBroker: { emit() {} } as never,
    pipgm: up.pipgm,
    pimatrix: up.pimatrix
  });
}

async function setup(fail: string[] = [], storeOptions: ConstructorParameters<typeof ActionListStore>[0] = {}) {
  const up = upstreams(fail);
  const registry = makeRegistry(up);
  const store = new ActionListStore(storeOptions);
  const app = Fastify();
  registerActionListRoutes(app, { store, execute: (r) => registry.execute(r), picontrolUrl: "https://picontrol.example" });
  return { app, store, calls: up.calls, registry };
}

const goLive = {
  name: "Sunday slides",
  steps: [
    { action: "pipgm:playlist-set", params: { feed: "pipgm1", itemIds: ["itm_a", "itm_b"], name: "Sunday" } },
    { action: "pipgm:route", params: { feed: "PiPGM1", output: "pi1" } },
    { action: "matrix:route", params: { input: 3, output: 1 } },
    { action: "pipgm:ftb", params: { feed: "PiPGM1", on: false } },
    { action: "pipgm:control", params: { feed: "PiPGM1", action: "gotoItem", itemIndex: 0 } }
  ]
};

test("the pipgm actions call piprogram and pimatrix as the specs define", async () => {
  const { registry, calls } = await setup();
  const run = async (action: string, params: Record<string, unknown>) => registry.execute({ action, params });

  assert.equal((await run("pipgm:playlist-set", { feed: "2", itemIds: ["a", "b"], name: "Sunday" })).ok, true);
  assert.equal((await run("pipgm:ftb", { feed: "PiPGM2", on: true })).ok, true);
  assert.equal((await run("pipgm:control", { feed: "PiPGM3", action: "gotoItem", itemIndex: 1 })).ok, true);
  assert.equal((await run("pipgm:route", { feed: "PiPGM1", output: "pi2" })).ok, true);

  assert.deepEqual(calls.map((c) => [c.target, c.method, c.path, c.body]), [
    ["piprogram", "PUT", "/api/v1/pipgm/pipelines/PiPGM2/playlist/order", { itemIds: ["a", "b"] }],
    ["piprogram", "POST", "/api/v1/pipgm/pipelines/PiPGM2/playlist/save", { name: "Sunday" }],
    ["piprogram", "POST", "/api/v1/pipgm/pipelines/PiPGM2/ftb", { fadeToBlack: true }],
    ["piprogram", "POST", "/api/v1/pipgm/pipelines/PiPGM3/control", { action: "gotoItem", itemIndex: 1 }],
    ["pimatrix", "PUT", "/api/v1/outputs/hdmi1/source", { sourceId: "PiPGM1" }]
  ]);

  assert.equal((await run("pipgm:ftb", { feed: "PiPGM9", on: true })).ok, false);
  assert.equal((await run("pipgm:ftb", { feed: "PiPGM1", on: "yes" })).ok, false);
  assert.equal((await run("pipgm:control", { feed: "PiPGM1", action: "explode" })).ok, false);
  assert.equal((await run("pipgm:route", { feed: "PiPGM1", output: "pi3" })).ok, false);
  assert.equal((await run("pipgm:playlist-set", { feed: "PiPGM1", itemIds: "a" })).ok, false);
});

test("the pipgm actions are listed, and unavailable without upstreams", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/v1/actions" });
  const actions = JSON.parse(res.payload).actions as Array<{ id: string; available: boolean }>;
  for (const id of ["pipgm:playlist-set", "pipgm:ftb", "pipgm:control", "pipgm:route"]) {
    assert.ok(actions.find((a) => a.id === id), id);
    assert.equal(actions.find((a) => a.id === id)!.available, false, `${id} is unavailable without PiProgram`);
  }
  await app.close();
});

test("an action list runs its steps in order and is single use", async () => {
  const { app, calls } = await setup();
  const created = await app.inject({ method: "POST", url: "/api/v1/action-lists", payload: { ...goLive, steps: goLive.steps.filter((s) => !s.action.startsWith("matrix:")) } });
  assert.equal(created.statusCode, 201);
  const list = created.json();
  assert.equal(list.state, "ready");
  assert.equal(list.link, `https://picontrol.example/run/${list.id}`);
  assert.equal(list.routesProjector, false);

  const run = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(run.statusCode, 200);
  assert.deepEqual(run.json().run.steps.map((s: { action: string; ok: boolean }) => [s.action, s.ok]), [
    ["pipgm:playlist-set", true],
    ["pipgm:route", true],
    ["pipgm:ftb", true],
    ["pipgm:control", true]
  ]);
  assert.deepEqual(calls.map((c) => c.path), [
    "/api/v1/pipgm/pipelines/PiPGM1/playlist/order",
    "/api/v1/pipgm/pipelines/PiPGM1/playlist/save",
    "/api/v1/outputs/hdmi0/source",
    "/api/v1/pipgm/pipelines/PiPGM1/ftb",
    "/api/v1/pipgm/pipelines/PiPGM1/control"
  ]);

  const again = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "ACTION_LIST_USED");
  assert.equal(calls.length, 5, "a used list runs nothing");
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/action-lists/${list.id}` })).json().state, "used");
});

test("a failing step stops the run and the list can be run again", async () => {
  const { app, calls } = await setup(["/ftb"]);
  const list = (await app.inject({ method: "POST", url: "/api/v1/action-lists", payload: { name: "x", steps: goLive.steps.filter((s) => !s.action.startsWith("matrix:")) } })).json();
  const run = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(run.statusCode, 502);
  assert.equal(run.json().error.code, "ACTION_LIST_STEP_FAILED");
  assert.equal(run.json().run.stoppedAt, 2);
  assert.equal(calls.filter((c) => c.path.endsWith("/control")).length, 0, "steps after the failure are not run");
  assert.equal(run.json().list.state, "ready", "the list can be retried after a failure");
});

test("an expired list is refused (410), an unknown one is 404", async () => {
  let now = Date.parse("2026-11-19T10:00:00Z");
  const { app } = await setup([], { now: () => now });
  const list = (await app.inject({ method: "POST", url: "/api/v1/action-lists", payload: { name: "x", steps: [{ action: "pipgm:ftb", params: { feed: "1", on: true } }], ttlSeconds: 60 } })).json();
  assert.equal(list.expiresAt, "2026-11-19T10:01:00.000Z");
  now += 61_000;
  const run = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(run.statusCode, 410);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/action-lists/nope" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/action-lists/nope/run" })).statusCode, 404);
});

test("the relay may not run a list that routes a projector", async () => {
  const { app, calls } = await setup();
  const list = (await app.inject({ method: "POST", url: "/api/v1/action-lists", payload: goLive })).json();
  assert.equal(list.routesProjector, true);
  const relay = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run`, headers: { "x-ui-role": "relay" } });
  assert.equal(relay.statusCode, 403);
  assert.equal(relay.json().error.code, "PROJECTOR_NOT_ON_RELAY");
  assert.equal(calls.length, 0);
  const lan = await app.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run`, headers: { "x-ui-role": "lan" } });
  assert.equal(lan.statusCode, 200);

  // a list without a matrix step may be run from the relay
  const plain = (await app.inject({ method: "POST", url: "/api/v1/action-lists", payload: { name: "p", steps: [{ action: "pipgm:ftb", params: { feed: "1", on: true } }] } })).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/action-lists/${plain.id}/run`, headers: { "x-ui-role": "relay" } })).statusCode, 200);
});

test("the Canva allowlist refuses other steps and bad params, and normalises the rest", () => {
  const bad = (steps: unknown[]) => validateCreate({ name: "x", steps }, "canva");
  for (const action of ["cam:preset", "encoder:start", "switch:cut", "rundown:next", "tally:cue", "pipgm:hymn"]) {
    assert.equal(bad([{ action, params: {} }]).ok, false, action);
  }
  assert.equal(bad([{ action: "matrix:route", params: { input: 1, output: 1 } }]).ok, false, "input must be a Pi input");
  assert.equal(bad([{ action: "matrix:route", params: { input: 3, output: 3 } }]).ok, false, "output must be a projector");
  assert.equal(bad([{ action: "matrix:route", params: { input: 3, output: 5 } }]).ok, false);
  assert.equal(bad([{ action: "pipgm:ftb", params: { feed: "PiPGM4", on: true } }]).ok, false);
  assert.equal(bad([{ action: "pipgm:control", params: { feed: "1", action: "kill" } }]).ok, false);
  assert.equal(bad([{ action: "pipgm:playlist-set", params: { feed: "1", itemIds: [] } }]).ok, false);
  assert.equal(validateCreate({ name: "", steps: [] }, "canva").ok, false);
  assert.equal(validateCreate({ name: "x", steps: Array(21).fill({ action: "pipgm:ftb", params: { feed: "1", on: true } }) }, "canva").ok, false);

  const ok = validateCreate({ name: " Go ", steps: [{ action: "pipgm:control", params: { feed: "2", action: "play", sneaky: 1 } }], ttlSeconds: 120 }, "canva");
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.value.steps, [{ action: "pipgm:control", params: { feed: "PiPGM2", action: "play" } }]);
    assert.equal(ok.value.name, "Go");
    assert.equal(ok.value.ttlSeconds, 120);
    assert.equal(ok.value.singleUse, true);
  }
  assert.equal(routesProjector({ steps: [{ action: "matrix:route" }] }), true);
});

test("the Canva routes create and read lists, but cannot run or delete them", async () => {
  const store = new ActionListStore();
  const app = Fastify();
  const service = new CanvaService({ piprogramUrl: "http://piprogram:3200" });
  registerCanvaRoutes(app, service, { actionLists: { store, picontrolUrl: "https://picontrol.example/" } });

  const refused = await app.inject({ method: "POST", url: "/api/v1/canva/action-lists", payload: { name: "x", steps: [{ action: "cam:preset", params: {} }] } });
  assert.equal(refused.statusCode, 422);
  assert.equal(store.list().length, 0);

  const created = await app.inject({ method: "POST", url: "/api/v1/canva/action-lists", payload: { ...goLive } });
  assert.equal(created.statusCode, 201);
  const list = created.json();
  assert.equal(list.createdBy, "canva");
  assert.equal(list.link, `https://picontrol.example/run/${list.id}`);
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/canva/action-lists/${list.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/canva/action-lists/${list.id}/run` })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/canva/action-lists/${list.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/canva/action-lists" })).statusCode, 404, "no listing either");
});

test("lists survive a restart when a directory is set, and expired ones are dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigateway-lists-"));
  try {
    let now = Date.parse("2026-11-19T10:00:00Z");
    const first = new ActionListStore({ dir, now: () => now });
    const v = validateCreate({ name: "keep", steps: [{ action: "pipgm:ftb", params: { feed: "1", on: true } }], ttlSeconds: 600 }, "canva");
    assert.ok(v.ok);
    if (!v.ok) return;
    const a = first.create(v.value, "canva");
    const b = first.create({ ...v.value, ttlSeconds: 30 }, "canva");
    assert.equal(readdirSync(dir).length, 2);

    now += 120_000;
    const second = new ActionListStore({ dir, now: () => now });
    assert.ok(second.get(a.id), "the live list is back");
    assert.equal(second.get(b.id), null, "the expired list is gone");
    assert.deepEqual(readdirSync(dir), [`${a.id}.json`]);
    assert.equal(second.delete(a.id), true);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UI listeners: read and run are on the allowlist for both roles, create and delete are not", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  assert.ok(findUiRoute("GET", `/api/v1/action-lists/${id}`));
  assert.ok(findUiRoute("POST", `/api/v1/action-lists/${id}/run`));
  assert.equal(findUiRoute("POST", "/api/v1/action-lists"), null);
  assert.equal(findUiRoute("GET", "/api/v1/action-lists"), null);
  assert.equal(findUiRoute("DELETE", `/api/v1/action-lists/${id}`), null);
  assert.equal(findUiRoute("POST", "/api/v1/canva/action-lists"), null);
  assert.equal(findUiRoute("POST", `/api/v1/action-lists/${id}/run`)!.setup, undefined, "not setup: the relay can run lists without a projector step");
});

test("through the relay listener a projector list is refused, through the LAN listener it runs", async () => {
  const up = upstreams();
  const store = new ActionListStore();
  const main = Fastify();
  const registry = makeRegistry(up);
  registerActionListRoutes(main, { store, execute: (r) => registry.execute(r) });
  const forward = createUiForward(main, loadConfig({ PIGATEWAY_MODE: "simulation" }));
  const lan = buildUiListener({ role: "lan", auth: createOpenAuth(), forward, logger: quiet });
  const relay = buildUiListener({ role: "relay", auth: createOpenAuth(), forward, logger: quiet });

  const list = store.create({ name: "x", steps: goLive.steps, singleUse: true, ttlSeconds: 900 }, "canva");
  const viaRelay = await relay.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(viaRelay.statusCode, 403);
  assert.equal(up.calls.length, 0);
  assert.equal((await relay.inject({ method: "GET", url: `/api/v1/action-lists/${list.id}` })).statusCode, 200);

  const viaLan = await lan.inject({ method: "POST", url: `/api/v1/action-lists/${list.id}/run` });
  assert.equal(up.calls.length, 5, "playlist order and save, route to the Pi output, ftb and control; the matrix step has no upstream call here");
});
