import type { FastifyInstance } from "fastify";
import type { ActionRegistry, ActionExecutionRequest } from "./action-registry.js";

export function registerActionRoutes(app: FastifyInstance, registry: ActionRegistry): void {
  // 1. GET /api/v1/actions - Action Catalog with dynamic availability
  app.get<{ Querystring: { available?: string } }>("/api/v1/actions", async (req) => {
    const availableOnly = req.query.available === "true" || req.query.available === "1";
    const actions = registry.listActions(availableOnly);
    return {
      service: "pigateway",
      total: actions.length,
      availableCount: actions.filter((a) => a.available).length,
      actions,
    };
  });

  // 2. POST /api/v1/actions/execute - Action Dispatcher
  app.post<{ Body: ActionExecutionRequest | { action: string; actor?: string; params?: Record<string, unknown> } }>(
    "/api/v1/actions/execute",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object" || !("action" in body) || !body.action) {
        return reply.status(400).send({ ok: false, error: "Missing 'action' in JSON body" });
      }

      const headerActor = req.headers["x-actor"];
      const defaultActor = typeof headerActor === "string" && headerActor.trim() ? headerActor.trim() : "unknown";

      const result = await registry.execute(body, defaultActor);
      if (!result.ok) {
        const status = result.error?.includes("not connected") || result.error?.includes("not available") ? 503 : 422;
        return reply.status(status).send(result);
      }

      return reply.status(200).send(result);
    }
  );
}
