import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("RundownStore - full lifecycle via pigateway endpoints", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  await app.ready();

  const rundownEvents: any[] = [];
  (app as any).eventBroker.subscribe((e: any) => {
    if (e.type === "rundown") {
      rundownEvents.push(e.data);
    }
  });

  // 1. Initial status before loading
  const initialRes = await app.inject({ method: "GET", url: "/api/v1/rundown" });
  assert.equal(initialRes.statusCode, 200);
  const initialJson = JSON.parse(initialRes.payload);
  assert.equal(initialJson.loaded, false);
  assert.equal(initialJson.currentIndex, -1);

  // 2. Load rundown document
  const sampleDoc = {
    title: "Messu 10:00",
    service: "Sunday Mass",
    church: "Keskuskirkko",
    date: "2026-11-01",
    preflight: {
      variables: {
        hymn_1: "332",
        preacher: "Pastori",
      },
    },
    rundown: [
      {
        id: "alkusoitto",
        title: "Alkusoitto",
        cue: { type: "sound", event: "music_stop" },
        actions: ["cam:cam1:preset:altar", { action: "atem:cut", params: { input: 1 } }],
      },
      {
        id: "alkusiunaus",
        title: "Alkusiunaus",
        cue: { type: "phrase", phrase: "Isän ja Pojan" },
        actions: ["cam:cam1:preset:pulpit"],
      },
      {
        id: "virsi_1",
        title: "Päivän virsi",
        actions: [{ action: "pipgm:hymn", params: { hymn: "{{hymn_1}}" } }],
      },
    ],
  };

  const loadRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/load",
    headers: { "x-actor": "operator" },
    payload: sampleDoc,
  });

  assert.equal(loadRes.statusCode, 200);
  const loadJson = JSON.parse(loadRes.payload);
  assert.equal(loadJson.ok, true);
  assert.equal(loadJson.rundown.loaded, true);
  assert.equal(loadJson.rundown.currentIndex, 0);
  assert.equal(loadJson.rundown.currentItem.id, "alkusoitto");
  assert.equal(loadJson.rundown.variables.hymn_1, "332");
  assert.equal(rundownEvents.length, 1);

  // 3. Step next
  const nextRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/next",
    headers: { "x-actor": "rundown" },
  });
  assert.equal(nextRes.statusCode, 200);
  const nextJson = JSON.parse(nextRes.payload);
  assert.equal(nextJson.advanced, true);
  assert.equal(nextJson.rundown.currentIndex, 1);
  assert.equal(nextJson.rundown.currentItem.id, "alkusiunaus");
  assert.equal(rundownEvents.length, 2);

  // 4. Step previous
  const prevRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/previous",
    headers: { "x-actor": "operator" },
  });
  assert.equal(prevRes.statusCode, 200);
  const prevJson = JSON.parse(prevRes.payload);
  assert.equal(prevJson.moved, true);
  assert.equal(prevJson.rundown.currentIndex, 0);

  // 5. Fire current item (alkusoitto) - executes actions & advances to alkusiunaus
  const fireRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/fire/alkusoitto",
    headers: { "x-actor": "rundown" },
  });
  assert.equal(fireRes.statusCode, 200);
  const fireJson = JSON.parse(fireRes.payload);
  assert.equal(fireJson.ok, true);
  assert.equal(fireJson.executed.length, 2); // cam preset + atem cut
  assert.equal(fireJson.rundown.currentIndex, 1); // Advanced to alkusiunaus

  // 6. Execute action via pigateway actions endpoint
  const actionRes = await app.inject({
    method: "POST",
    url: "/api/v1/actions/execute",
    payload: {
      action: "rundown:fire",
      actor: "picontrol",
    },
  });
  assert.equal(actionRes.statusCode, 200);
  const actionJson = JSON.parse(actionRes.payload);
  assert.equal(actionJson.ok, true);
  assert.equal(actionJson.actor, "picontrol");

  // Pointer should now be at virsi_1 (index 2)
  const currentStatus = await app.inject({ method: "GET", url: "/api/v1/rundown" });
  const statusJson = JSON.parse(currentStatus.payload);
  assert.equal(statusJson.currentIndex, 2);
  assert.equal(statusJson.currentItem.id, "virsi_1");

  // 7. Test Variables endpoint
  const varSetRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/variables",
    payload: { name: "speaker", value: "Piispa" },
  });
  assert.equal(varSetRes.statusCode, 200);
  const varsRes = await app.inject({ method: "GET", url: "/api/v1/rundown/variables" });
  assert.equal(JSON.parse(varsRes.payload).variables.speaker, "Piispa");

  // 8. Test Goto
  const gotoRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/goto/alkusoitto",
    headers: { "x-actor": "operator" },
  });
  assert.equal(gotoRes.statusCode, 200);
  assert.equal(JSON.parse(gotoRes.payload).rundown.currentIndex, 0);

  // 9. Test Reset
  const resetRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/reset",
    headers: { "x-actor": "operator" },
  });
  assert.equal(resetRes.statusCode, 200);
  assert.equal(JSON.parse(resetRes.payload).rundown.currentIndex, 0);

  await app.close();
});
