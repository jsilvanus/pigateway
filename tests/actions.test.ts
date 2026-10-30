import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ActionRegistry } from "../src/actions/action-registry.js";

test("actions endpoint returns catalog of actions with dynamic availability", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/actions",
  });

  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.payload);
  assert.equal(json.service, "pigateway");
  assert.ok(Array.isArray(json.actions));
  assert.ok(json.actions.length > 5);

  const switchAction = json.actions.find((a: any) => a.id === "switch:cut");
  assert.ok(switchAction);
  assert.equal(switchAction.domain, "switch");

  const switchPreview = json.actions.find((a: any) => a.id === "switch:preview");
  assert.ok(switchPreview);
  assert.equal(switchPreview.domain, "switch");

  const atemAction = json.actions.find((a: any) => a.id === "atem:cut");
  assert.ok(atemAction);
  assert.equal(atemAction.domain, "atem");

  const camAction = json.actions.find((a: any) => a.id === "cam:preset");
  assert.ok(camAction);
  assert.equal(camAction.domain, "camera");
  assert.equal(camAction.available, true); // Cam is simulated and available

  const rundownAction = json.actions.find((a: any) => a.id === "rundown:cues");
  assert.ok(rundownAction);
  assert.equal(rundownAction.domain, "rundown");
  assert.equal(rundownAction.available, true);

  // Test available-only filter
  const availRes = await app.inject({
    method: "GET",
    url: "/api/v1/actions?available=true",
  });
  assert.equal(availRes.statusCode, 200);
  const availJson = JSON.parse(availRes.payload);
  for (const a of availJson.actions) {
    assert.equal(a.available, true);
  }

  await app.close();
});

test("action execution runs camera preset and emits event with actor", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();

  const actionEvents: any[] = [];
  (app as any).eventBroker.subscribe((e: any) => {
    if (e.type === "action") {
      actionEvents.push(e.data);
    }
  });

  // 1. Structured action execution with explicit actor
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "cam:preset",
      actor: "rundown",
      params: { id: "cam1", preset: "altar" },
    },
  });

  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.payload);
  assert.equal(json.ok, true);
  assert.equal(json.action, "cam:preset");
  assert.equal(json.actor, "rundown");

  // Verify event payload includes actor
  assert.equal(actionEvents.length, 1);
  assert.equal(actionEvents[0].actor, "rundown");
  assert.equal(actionEvents[0].action, "cam:preset");

  // 2. Shorthand string action in JSON payload with header actor
  const strRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    headers: {
      "x-actor": "picontrol",
    },
    payload: { action: "cam:cam1:preset:pulpit" },
  });

  assert.equal(strRes.statusCode, 200);
  const strJson = JSON.parse(strRes.payload);
  assert.equal(strJson.ok, true);
  assert.equal(strJson.actor, "picontrol");
  assert.equal(actionEvents.length, 2);
  assert.equal(actionEvents[1].actor, "picontrol");

  // 3. Matrix route execution without actor (defaults to unknown)
  const matrixRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "matrix:route",
      params: { input: 1, output: 2 },
    },
  });

  assert.equal(matrixRes.statusCode, 200);
  const matrixJson = JSON.parse(matrixRes.payload);
  assert.equal(matrixJson.ok, true);
  assert.equal(matrixJson.actor, "unknown");

  // 4. Switch preview and cut execution
  const prevRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "switch:preview",
      params: { input: 3 },
      actor: "rundown",
    },
  });
  assert.equal(prevRes.statusCode, 200);
  assert.equal(JSON.parse(prevRes.payload).ok, true);

  const cutRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "switch:cut",
      actor: "rundown",
    },
  });
  assert.equal(cutRes.statusCode, 200);
  assert.equal(JSON.parse(cutRes.payload).ok, true);

  // 5. Named camera input mapping: atem:preview:cam1
  const cam1Res = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "atem:preview:cam1",
      actor: "rundown",
    },
  });
  assert.equal(cam1Res.statusCode, 200);
  const cam1Json = JSON.parse(cam1Res.payload);
  assert.equal(cam1Json.ok, true);
  assert.equal(cam1Json.result?.input, 1);
  assert.equal(cam1Json.result?.source, "cam1");

  // 6. Automatic routing for pastorphone (piswitch -> pimatrix -> atlona)
  const pastorRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "atem:preview:pastorphone",
      actor: "rundown",
    },
  });
  assert.equal(pastorRes.statusCode, 200);
  const pastorJson = JSON.parse(pastorRes.payload);
  assert.equal(pastorJson.ok, true);
  assert.equal(pastorJson.result?.input, 4); // switch matrix input
  assert.equal(pastorJson.result?.source, "pastorphone");
  assert.equal(pastorJson.result?.matrix?.routed, true);
  assert.equal(pastorJson.result?.matrix?.atlonaInput, 4);
  assert.equal(pastorJson.result?.matrix?.atlonaOutput, 5);

  // 7. Invalid action gives 422 with actor preserved
  const badRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: { action: "unknown:thing", actor: "operator" },
  });
  assert.equal(badRes.statusCode, 422);
  const badJson = JSON.parse(badRes.payload);
  assert.equal(badJson.actor, "operator");

  await app.close();
});

test("ActionRegistry - routes rundown:cues to pirundown service with actor", async () => {
  const fetchCalls: Array<{ url: string; body: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, cueEngineEnabled: false }), { status: 200 });
  };

  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();

  const registry = new ActionRegistry({
    config: loadConfig({}),
    atem: {} as any,
    cameraService: {} as any,
    encoder: {} as any,
    matrix: {} as any,
    ecosystemTracker: { getSummary: () => ({ components: {} }) } as any,
    eventBroker: (app as any).eventBroker,
    fetchFn: mockFetch,
  });

  // 1. Toggle off via state param
  const res = await registry.execute({
    action: "rundown:cues",
    actor: "operator",
    params: { state: "off" },
  });

  assert.equal(res.ok, true);
  assert.equal(res.actor, "operator");
  assert.equal(res.target, "rundown:cues");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "http://127.0.0.1:3400/api/v1/cues/disable");

  // 2. String shorthand toggle
  const strRes = await registry.execute("rundown:cues:toggle", "operator");
  assert.equal(strRes.ok, true);
  assert.equal(strRes.actor, "operator");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1]?.url, "http://127.0.0.1:3400/api/v1/cues/toggle");

  await app.close();
});
