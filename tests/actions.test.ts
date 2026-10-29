import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

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

  const atemAction = json.actions.find((a: any) => a.id === "atem:cut");
  assert.ok(atemAction);
  assert.equal(atemAction.domain, "atem");

  const camAction = json.actions.find((a: any) => a.id === "cam:preset");
  assert.ok(camAction);
  assert.equal(camAction.domain, "camera");
  assert.equal(camAction.available, true); // Cam is simulated and available

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

  // 4. Invalid action gives 422 with actor preserved
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
