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

test("action execution runs camera preset and emits event", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();

  // 1. Structured action execution
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "cam:preset",
      params: { id: "cam1", preset: "altar" },
    },
  });

  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.payload);
  assert.equal(json.ok, true);
  assert.equal(json.action, "cam:preset");

  // 2. Shorthand string action in JSON payload
  const strRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: { action: "cam:cam1:preset:pulpit" },
  });

  assert.equal(strRes.statusCode, 200);
  const strJson = JSON.parse(strRes.payload);
  assert.equal(strJson.ok, true);

  // 3. Matrix route execution
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

  // 4. Invalid action gives 422
  const badRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: { action: "unknown:thing" },
  });
  assert.equal(badRes.statusCode, 422);

  await app.close();
});
