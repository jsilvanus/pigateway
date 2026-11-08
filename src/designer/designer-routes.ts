import type { FastifyInstance } from "fastify";
import type { PiDesignerClient } from "./client.js";

export function registerDesignerRoutes(app: FastifyInstance, options: { client: PiDesignerClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "DESIGNER_ERROR", message: error.message }
      });
    }
  };

  // State
  app.get("/api/v1/designer/state", async (_request, reply) => {
    return handle(() => client.getState(), reply);
  });

  app.post("/api/v1/designer/state", async (request, reply) => {
    return handle(() => client.setState(request.body), reply);
  });

  // Items
  app.post("/api/v1/designer/items", async (request, reply) => {
    return handle(() => client.addItem(request.body), reply);
  });

  app.put<{ Params: { id: string } }>("/api/v1/designer/items/:id", async (request, reply) => {
    return handle(() => client.updateItem(request.params.id, request.body), reply);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/designer/items/:id", async (request, reply) => {
    return handle(() => client.deleteItem(request.params.id), reply);
  });

  // Metadata
  app.patch("/api/v1/designer/metadata", async (request, reply) => {
    return handle(() => client.setMetadata(request.body), reply);
  });

  // Template
  app.post("/api/v1/designer/template", async (request, reply) => {
    return handle(() => client.loadTemplate(request.body), reply);
  });

  // Agent Chat
  app.post("/api/v1/designer/agent/chat", async (request, reply) => {
    return handle(() => client.agentChat(request.body), reply);
  });

  // Templates list & get
  app.get("/api/v1/designer/templates", async (_request, reply) => {
    return handle(() => client.listTemplates(), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/designer/templates/:id", async (request, reply) => {
    return handle(() => client.getTemplate(request.params.id), reply);
  });

  // Validation
  app.post("/api/v1/designer/validate", async (request, reply) => {
    return handle(() => client.validate(request.body), reply);
  });

  // Push to rundown
  app.post("/api/v1/designer/push", async (request, reply) => {
    return handle(() => client.push(request.body), reply);
  });
}
