import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { HttpPicamCameraAdapter } from "../src/camera/picam-adapter.js";
import { CameraService } from "../src/camera/camera-service.js";
import { ActionRegistry } from "../src/actions/action-registry.js";
import { AtemAdapter } from "../src/atem/atem-adapter.js";
import { EncoderService } from "../src/encoder/encoder-service.js";
import { AtlonaMatrix } from "../src/amx/atlona.js";
import { EcosystemTracker } from "../src/ecosystem/ecosystem-tracker.js";
import { GatewayEventBroker } from "../src/events.js";
import { loadConfig } from "../src/config.js";

test("HttpPicamCameraAdapter delegates preset recall, move, and zoom over HTTP to PiCam", async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];

  // Mock picam HTTP server
  const picamServer = Fastify({ logger: false });
  picamServer.post("/api/v1/cameras/:id/presets/:presetId/recall", async (req) => {
    calls.push({ url: req.url, method: "POST" });
    return { success: true, cameraId: (req.params as any).id, action: `preset:recall:${(req.params as any).presetId}` };
  });
  picamServer.post("/api/v1/cameras/:id/move", async (req) => {
    calls.push({ url: req.url, method: "POST", body: req.body });
    return { success: true, cameraId: (req.params as any).id, action: "move" };
  });
  picamServer.post("/api/v1/cameras/:id/zoom", async (req) => {
    calls.push({ url: req.url, method: "POST", body: req.body });
    return { success: true, cameraId: (req.params as any).id, action: "zoom" };
  });
  picamServer.get("/api/v1/cameras/:id", async (req) => {
    calls.push({ url: req.url, method: "GET" });
    return {
      id: (req.params as any).id,
      label: "Mock Camera",
      model: "AVer PTZ330",
      connection: "connected",
      presets: [{ id: 1, name: "Pulpit" }, { id: 2, name: "Altar" }]
    };
  });

  const address = await picamServer.listen({ port: 0, host: "127.0.0.1" });

  try {
    const adapter = new HttpPicamCameraAdapter({
      id: "cam1",
      label: "Camera 1",
      baseUrl: address
    });

    await adapter.recallPreset(2);
    await adapter.move("left", 12, 10);
    await adapter.zoom("in", 5);

    assert.ok(calls.some((c) => c.url === "/api/v1/cameras/cam1/presets/2/recall" && c.method === "POST"));
    assert.ok(calls.some((c) => c.url === "/api/v1/cameras/cam1/move" && c.body?.direction === "left"));
    assert.ok(calls.some((c) => c.url === "/api/v1/cameras/cam1/zoom" && c.body?.action === "in"));
  } finally {
    await picamServer.close();
  }
});

test("ActionRegistry cam:preset executes via delegated CameraService when picamApiUrl is configured", async () => {
  const calls: string[] = [];

  const picamServer = Fastify({ logger: false });
  picamServer.post("/api/v1/cameras/:id/presets/:presetId/recall", async (req) => {
    calls.push(req.url);
    return { success: true, cameraId: (req.params as any).id, action: "preset:recall" };
  });

  const address = await picamServer.listen({ port: 0, host: "127.0.0.1" });

  try {
    const eventBroker = new GatewayEventBroker();
    const config = loadConfig({ PIGATEWAY_PICAM_API_URL: address } as any);
    const cameraService = new CameraService({
      mode: "simulation",
      picamApiUrl: address,
      eventBroker
    });

    const actionRegistry = new ActionRegistry({
      config,
      atem: new AtemAdapter(),
      cameraService,
      encoder: new EncoderService({ host: undefined }),
      matrix: new AtlonaMatrix(),
      ecosystemTracker: new EcosystemTracker({ config }),
      eventBroker
    });

    const result = await actionRegistry.execute({
      action: "cam:preset",
      params: { id: "cam1", preset: 3 }
    });

    assert.equal(result.ok, true);
    assert.equal(result.target, "camera:cam1:preset");
    assert.ok(calls.includes("/api/v1/cameras/cam1/presets/3/recall"));
  } finally {
    await picamServer.close();
  }
});
