import type { FastifyInstance } from "fastify";
import type { PiStorageClient } from "./client.js";

export function registerStorageRoutes(app: FastifyInstance, options: { client: PiStorageClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "STORAGE_ERROR", message: error.message }
      });
    }
  };

  app.get("/api/v1/storage/status", async (_request, reply) => {
    return handle(() => client.getStatus(), reply);
  });

  app.get<{ Querystring: { prefix?: string; limit?: string } }>("/api/v1/storage/objects", async (request, reply) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return handle(() => client.listObjects(request.query.prefix, limit), reply);
  });

  app.get<{ Params: { "*": string } }>("/api/v1/storage/objects/*", async (request, reply) => {
    const key = request.params["*"];
    return handle(() => client.getObject(key), reply);
  });

  app.put<{ Params: { "*": string } }>("/api/v1/storage/objects/*", async (request, reply) => {
    const key = request.params["*"];
    const contentType = request.headers["content-type"];
    return handle(() => client.putObject(key, request.body, contentType), reply);
  });

  app.delete<{ Params: { "*": string } }>("/api/v1/storage/objects/*", async (request, reply) => {
    const key = request.params["*"];
    return handle(() => client.deleteObject(key), reply);
  });

  app.post("/api/v1/storage/signed-urls", async (request, reply) => {
    return handle(() => client.createSignedUrl(request.body), reply);
  });

  app.post("/api/v1/storage/use-at", async (request, reply) => {
    return handle(() => client.setUseAt(request.body), reply);
  });

  app.post("/api/v1/storage/spool/flush", async (_request, reply) => {
    return handle(() => client.flushSpool(), reply);
  });

  app.post("/api/v1/storage/cache/prune", async (_request, reply) => {
    return handle(() => client.pruneCache(), reply);
  });
}
