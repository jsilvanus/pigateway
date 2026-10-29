import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { EcosystemTracker } from "../src/ecosystem/ecosystem-tracker.js";
import { GatewayEventBroker, type GatewayEvent } from "../src/events.js";

test("EcosystemTracker tracks default services and respects probe responses", async () => {
  let probeTargetOnline = false;
  const probedUrls: string[] = [];
  const eventBroker = new GatewayEventBroker();
  const events: GatewayEvent[] = [];
  eventBroker.subscribe((e) => events.push(e));

  const tracker = new EcosystemTracker({
    config: loadConfig({}),
    eventBroker,
    probeFetch: async (url) => {
      probedUrls.push(url);
      if (url.includes(":3300") && probeTargetOnline) return true;
      if (url.includes(":3200")) return true; // simulate pilight online
      return false;
    }
  });

  // Initially before probing
  const initial = tracker.getSummary();
  assert.equal(initial.service, "pigateway");
  assert.ok(initial.components.pisound);
  assert.ok(initial.components.pivoice);
  assert.ok(initial.components.pitube);
  assert.ok(initial.components.pilight);
  assert.ok(initial.components.pimatrix);
  assert.ok(initial.components.piprogram);
  assert.ok(initial.components.picanva);
  assert.ok(initial.components.auditor);
  assert.ok(initial.components.atem);
  assert.ok(initial.components.cameras);
  assert.equal(initial.components.pisound.active, false);

  // Probe all
  const afterProbe = await tracker.probeAll();
  assert.ok(probedUrls.length >= 7);
  // pilight was simulated online
  assert.equal(afterProbe.components.pilight.active, true);
  assert.equal(afterProbe.components.pilight.available, true);
  assert.ok(afterProbe.inUseTabs.includes("tally"));
  assert.ok(afterProbe.activePlugins.includes("pilight"));

  // Check event emitted
  const ecoEvents = events.filter((e) => e.type === "ecosystem");
  assert.ok(ecoEvents.length >= 1);
});

test("EcosystemTracker activates PiSound UDP receiver dynamically when detected", async () => {
  let activated = false;
  let probeOk = false;
  const tracker = new EcosystemTracker({
    config: loadConfig({}),
    probeFetch: async () => probeOk,
    onPisoundActivate: async () => {
      activated = true;
    }
  });

  assert.equal(await tracker.shouldStartPisoundReceiver(), false);
  assert.equal(activated, false);

  // Now PiSound comes online
  probeOk = true;
  await tracker.probeAll();
  assert.equal(activated, true);
  assert.equal(tracker.getSummary().components.pisound.active, true);
  assert.ok(tracker.getSummary().inUseTabs.includes("sound"));
});

test("app serves GET /api/v1/ecosystem and POST /api/v1/ecosystem/probe", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_PISOUND_UDP_PORT: "0", PIGATEWAY_PIVOICE_UDP_PORT: "0" }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/v1/ecosystem" });
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.service, "pigateway");
  assert.ok(Array.isArray(data.inUseTabs));
  assert.ok(Array.isArray(data.activePlugins));
  assert.ok(data.components.pisound);
  assert.ok(data.components.pitube);

  // Status also includes ecosystem fields
  const statusRes = await app.inject({ method: "GET", url: "/api/v1/status" });
  assert.equal(statusRes.statusCode, 200);
  const statusData = statusRes.json();
  assert.ok(statusData.ecosystem);
  assert.deepEqual(statusData.inUseTabs, data.inUseTabs);
  assert.deepEqual(statusData.activePlugins, data.activePlugins);

  // Probe endpoint works
  const probeRes = await app.inject({ method: "POST", url: "/api/v1/ecosystem/probe" });
  assert.equal(probeRes.statusCode, 200);
  const probeData = probeRes.json();
  assert.equal(probeData.service, "pigateway");

  await app.close();
});

test("pitube reporting status activates youtube in ecosystem", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_PISOUND_UDP_PORT: "0", PIGATEWAY_PIVOICE_UDP_PORT: "0" }));
  await app.ready();

  // Initially pitube is offline/unknown
  const eco1 = (await app.inject({ method: "GET", url: "/api/v1/ecosystem" })).json();
  assert.equal(eco1.components.pitube.active, false);

  // pitube reports status
  const reportRes = await app.inject({
    method: "PUT",
    url: "/api/v1/youtube/status",
    payload: { state: "live", checkedAt: Date.now(), ttlMs: 10000, detail: "Stream healthy" }
  });
  assert.equal(reportRes.statusCode, 200);

  // Now pitube is inUse and active
  const eco2 = (await app.inject({ method: "GET", url: "/api/v1/ecosystem" })).json();
  assert.equal(eco2.components.pitube.active, true);
  assert.equal(eco2.components.pitube.connecting, true);
  assert.ok(eco2.inUseTabs.includes("youtube"));
  assert.ok(eco2.activePlugins.includes("pitube"));

  // Check /api/v1/status matches
  const status = (await app.inject({ method: "GET", url: "/api/v1/status" })).json();
  assert.ok(status.inUseTabs.includes("youtube"));
  assert.ok(status.activePlugins.includes("pitube"));

  await app.close();
});

test("PiSound UDP listener is skipped when PiSound is not active", async () => {
  // PIGATEWAY_PISOUND_ENABLED=false explicitly disables it
  const app = buildApp(loadConfig({ PIGATEWAY_PISOUND_ENABLED: "false", PIGATEWAY_PIVOICE_UDP_PORT: "0" }));
  await app.ready();

  const soundRes = await app.inject({ method: "GET", url: "/api/v1/sound" });
  assert.equal(soundRes.statusCode, 200);
  assert.equal(soundRes.json().connected, false);

  const eco = (await app.inject({ method: "GET", url: "/api/v1/ecosystem" })).json();
  assert.equal(eco.components.pisound.active, false);
  assert.equal(eco.inUseTabs.includes("sound"), false);

  await app.close();
});
