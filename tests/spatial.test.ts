import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("pigateway spatial endpoints accept updates and emit events", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();

  // Initial spatial scene is empty
  const initial = await app.inject({ method: "GET", url: "/api/v1/spatial" });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().activeZones, []);

  // Update spatial scene
  const scenePayload = {
    updatedAt: new Date().toISOString(),
    activeZones: ["pulpit"],
    subjects: [
      {
        trackId: 1,
        sourceCameraId: "cam1",
        position: { x: -3.5, y: 0.5, z: 1.3 },
        zoneId: "pulpit",
        zoneName: "Saarnastuoli",
        confidence: 0.92,
        label: "preacher",
        lastSeenAt: new Date().toISOString(),
      },
    ],
    cameras: {
      cam1: { pan: 250, tilt: -12, zoom: 2000, activeZoneId: "pulpit" },
    },
  };

  const putRes = await app.inject({
    method: "PUT",
    url: "/api/v1/spatial/scene",
    payload: scenePayload,
  });
  assert.equal(putRes.statusCode, 200);

  // Check scene updated
  const updated = await app.inject({ method: "GET", url: "/api/v1/spatial" });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().activeZones, ["pulpit"]);
  assert.equal(updated.json().subjects[0].zoneId, "pulpit");

  // Post zone transition event
  const zoneEvt = {
    event: "entered",
    trackId: 1,
    zoneId: "pulpit",
    zoneName: "Saarnastuoli",
    sourceCameraId: "cam1",
    timestamp: new Date().toISOString(),
  };

  const evtRes = await app.inject({
    method: "POST",
    url: "/api/v1/spatial/events",
    payload: zoneEvt,
  });
  assert.equal(evtRes.statusCode, 200);
  assert.equal(evtRes.json().ok, true);

  await app.close();
});
