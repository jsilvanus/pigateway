import type { FastifyInstance } from "fastify";
import type { SpatialStatusStore } from "./spatial-status.js";
import type { SpatialScenePayload, SpatialZoneEventPayload } from "../events.js";

export function registerSpatialRoutes(app: FastifyInstance, store: SpatialStatusStore): void {
  app.get("/api/v1/spatial", async () => store.get());

  app.put<{ Body: SpatialScenePayload }>("/api/v1/spatial/scene", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.activeZones) || !Array.isArray(body.subjects)) {
      return reply.code(422).send({ error: { code: "INVALID_SPATIAL_SCENE", message: "Invalid spatial scene payload" } });
    }
    return store.updateScene(body);
  });

  app.post<{ Body: SpatialZoneEventPayload }>("/api/v1/spatial/events", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !body.event || !body.zoneId || body.trackId == null) {
      return reply.code(422).send({ error: { code: "INVALID_ZONE_EVENT", message: "Invalid spatial zone event payload" } });
    }
    store.emitZoneEvent(body);
    return { ok: true };
  });
}
