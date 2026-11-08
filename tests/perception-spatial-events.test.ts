import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { GatewayEventBroker, GatewayEvent } from "../src/events.js";

test("event bus receives perception detections via POST /api/v1/events and POST /api/v1/perception/events", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();

  const broker = (app as unknown as { eventBroker: GatewayEventBroker }).eventBroker;
  const received: GatewayEvent[] = [];
  const unsub = broker.subscribe((e) => received.push(e));

  // 1. Post via generic POST /api/v1/events (used by piperception PiSpacePusher)
  const pushRes = await app.inject({
    method: "POST",
    url: "/api/v1/events",
    payload: {
      type: "perception",
      data: {
        cameraId: "cam1",
        objects: [
          {
            trackId: 101,
            bbox: { x: 0.2, y: 0.3, w: 0.15, h: 0.4 },
            label: "person",
            confidence: 0.95
          }
        ]
      }
    }
  });
  assert.equal(pushRes.statusCode, 200);
  assert.equal(pushRes.json().ok, true);

  // 2. Post via dedicated POST /api/v1/perception/events
  const directRes = await app.inject({
    method: "POST",
    url: "/api/v1/perception/events",
    payload: {
      cameraId: "cam2",
      objects: [
        {
          trackId: 102,
          bbox: { x: 0.5, y: 0.4, w: 0.1, h: 0.3 },
          label: "person",
          confidence: 0.88
        }
      ]
    }
  });
  assert.equal(directRes.statusCode, 200);
  assert.equal(directRes.json().ok, true);

  // Verify events reached the broker
  const perceptionEvents = received.filter((e) => e.type === "perception");
  assert.equal(perceptionEvents.length, 2);
  assert.equal((perceptionEvents[0].data as any).cameraId, "cam1");
  assert.equal((perceptionEvents[1].data as any).cameraId, "cam2");

  unsub();
  await app.close();
});

test("spatial routes proxy to PiSpace when configured", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();

  // Without PISPACE configured, returns 503
  const venueRes = await app.inject({ method: "GET", url: "/api/v1/spatial/venue" });
  assert.equal(venueRes.statusCode, 503);
  assert.equal(venueRes.json().error.code, "PISPACE_NOT_CONFIGURED");

  const zonesRes = await app.inject({ method: "GET", url: "/api/v1/spatial/zones" });
  assert.equal(zonesRes.statusCode, 503);

  const occludersRes = await app.inject({ method: "GET", url: "/api/v1/spatial/occluders" });
  assert.equal(occludersRes.statusCode, 503);

  const solveRes = await app.inject({
    method: "POST",
    url: "/api/v1/spatial/solve-ptz",
    payload: { cameraId: "cam1", target: { zoneId: "altar" } }
  });
  assert.equal(solveRes.statusCode, 503);

  await app.close();
});
