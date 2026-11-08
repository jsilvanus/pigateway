import type { FastifyInstance } from "fastify";
import type { PiGraphicsClient } from "./client.js";

export function registerGraphicsRoutes(app: FastifyInstance, options: { client: PiGraphicsClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "GRAPHICS_ERROR", message: error.message }
      });
    }
  };

  // Active graphics
  app.get("/api/v1/graphics/active", async (_request, reply) => {
    return handle(() => client.getActive(), reply);
  });

  app.post("/api/v1/graphics/active/show", async (request, reply) => {
    return handle(() => client.showGraphic(request.body), reply);
  });

  app.post<{ Params: { instanceId: string } }>("/api/v1/graphics/active/hide/:instanceId", async (request, reply) => {
    return handle(() => client.hideGraphic(request.params.instanceId), reply);
  });

  app.post("/api/v1/graphics/active/clear", async (_request, reply) => {
    return handle(() => client.clearGraphics(), reply);
  });

  // Bindings
  app.get("/api/v1/graphics/bindings", async (_request, reply) => {
    return handle(() => client.getBindings(), reply);
  });

  app.post("/api/v1/graphics/bindings", async (request, reply) => {
    return handle(() => client.setBindings(request.body), reply);
  });

  // Templates
  app.get("/api/v1/graphics/templates", async (_request, reply) => {
    return handle(() => client.listTemplates(), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/graphics/templates/:id", async (request, reply) => {
    return handle(() => client.getTemplate(request.params.id), reply);
  });

  app.post("/api/v1/graphics/templates", async (request, reply) => {
    return handle(() => client.saveTemplate(request.body), reply);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/graphics/templates/:id", async (request, reply) => {
    return handle(() => client.deleteTemplate(request.params.id), reply);
  });

  // Assets
  app.get("/api/v1/graphics/assets", async (_request, reply) => {
    return handle(() => client.listAssets(), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/graphics/assets/:id", async (request, reply) => {
    return handle(() => client.getAsset(request.params.id), reply);
  });

  app.post("/api/v1/graphics/assets", async (request, reply) => {
    return handle(() => client.uploadAsset(request.body), reply);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/graphics/assets/:id", async (request, reply) => {
    return handle(() => client.deleteAsset(request.params.id), reply);
  });

  // Canva integration endpoints
  app.post("/api/v1/graphics/canva/push", async (request, reply) => {
    return handle(() => client.canvaPush(request.body), reply);
  });

  app.post("/api/v1/graphics/canva/off-air", async (request, reply) => {
    return handle(() => client.canvaOffAir(request.body), reply);
  });

  // Stream status and control
  app.get("/api/v1/graphics/stream/status", async (_request, reply) => {
    return handle(() => client.getStreamStatus(), reply);
  });

  app.post("/api/v1/graphics/stream/start", async (request, reply) => {
    return handle(() => client.startStream(request.body), reply);
  });

  app.post("/api/v1/graphics/stream/stop", async (_request, reply) => {
    return handle(() => client.stopStream(), reply);
  });
}
