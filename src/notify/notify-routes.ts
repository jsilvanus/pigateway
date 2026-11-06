import type { FastifyInstance } from "fastify";
import type { PiNotifyClient } from "./client.js";

export function registerNotifyRoutes(app: FastifyInstance, options: { client: PiNotifyClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "NOTIFY_ERROR", message: error.message }
      });
    }
  };

  app.post("/api/v1/notify", async (request, reply) => {
    return handle(() => client.send(request.body), reply);
  });

  app.get("/api/v1/notify/contacts", async (_request, reply) => {
    return handle(() => client.getContacts(), reply);
  });

  app.post("/api/v1/notify/contacts", async (request, reply) => {
    return handle(() => client.createContact(request.body), reply);
  });

  app.get<{ Params: { slug: string } }>("/api/v1/notify/contacts/:slug", async (request, reply) => {
    return handle(() => client.getContact(request.params.slug), reply);
  });

  app.put<{ Params: { slug: string } }>("/api/v1/notify/contacts/:slug", async (request, reply) => {
    return handle(() => client.updateContact(request.params.slug, request.body), reply);
  });

  app.delete<{ Params: { slug: string } }>("/api/v1/notify/contacts/:slug", async (request, reply) => {
    return handle(() => client.deleteContact(request.params.slug), reply);
  });

  app.get("/api/v1/notify/provider", async (_request, reply) => {
    return handle(() => client.getProvider(), reply);
  });

  app.put("/api/v1/notify/provider", async (request, reply) => {
    return handle(() => client.updateProvider(request.body), reply);
  });

  app.delete("/api/v1/notify/provider", async (_request, reply) => {
    return handle(() => client.deleteProvider(), reply);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/notify/log", async (request, reply) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return handle(() => client.getLog(limit), reply);
  });

  app.get("/api/v1/notify/outbox", async (_request, reply) => {
    return handle(() => client.getOutbox(), reply);
  });
}
