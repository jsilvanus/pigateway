import type { FastifyInstance } from "fastify";
import type { PiPoeClient } from "./client.js";

export function registerPoeRoutes(app: FastifyInstance, options: { client: PiPoeClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "POE_ERROR", message: error.message }
      });
    }
  };

  app.get("/api/v1/poe", async (_request, reply) => {
    return handle(() => client.listPorts(), reply);
  });

  app.get<{ Params: { port: string } }>("/api/v1/poe/ports/:port", async (request, reply) => {
    return handle(() => client.getPort(request.params.port), reply);
  });

  app.post<{ Params: { port: string }; Body: { enabled?: unknown } }>("/api/v1/poe/ports/:port/power", async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") {
      return reply.code(400).send({ error: { code: "INVALID_BODY", message: "enabled must be a boolean" } });
    }
    return handle(() => client.setPower(request.params.port, enabled), reply);
  });

  app.post<{ Params: { port: string }; Body: { offMs?: unknown } | undefined }>("/api/v1/poe/ports/:port/cycle", async (request, reply) => {
    const offMs = request.body?.offMs;
    if (offMs !== undefined && (typeof offMs !== "number" || !Number.isFinite(offMs))) {
      return reply.code(400).send({ error: { code: "INVALID_BODY", message: "offMs must be a number" } });
    }
    return handle(() => client.cyclePort(request.params.port, offMs as number | undefined), reply);
  });
}
