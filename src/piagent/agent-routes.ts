import type { FastifyInstance } from "fastify";
import type { PiAgentClient } from "./client.js";

export function registerAgentRoutes(app: FastifyInstance, options: { client: PiAgentClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "AGENT_ERROR", message: error.message }
      });
    }
  };

  app.get("/api/v1/agents", async (_request, reply) => {
    return handle(() => client.getAgents(), reply);
  });

  app.post("/api/v1/agents", async (request, reply) => {
    return handle(() => client.createAgent(request.body), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    return handle(() => client.getAgent(request.params.id), reply);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    return handle(() => client.deleteAgent(request.params.id), reply);
  });

  app.post<{ Params: { id: string } }>("/api/v1/agents/:id/stop", async (request, reply) => {
    return handle(() => client.stopAgent(request.params.id, request.body), reply);
  });

  app.post("/api/v1/agent/interrupt", async (request, reply) => {
    return handle(() => client.interruptAgent(request.body), reply);
  });

  app.post("/api/v1/chat", async (request, reply) => {
    return handle(() => client.chat(request.body), reply);
  });

  app.post("/api/v1/messages", async (request, reply) => {
    return handle(() => client.sendMessage(request.body), reply);
  });

  app.get<{ Params: { agentId: string } }>("/api/v1/messages/inbox/:agentId", async (request, reply) => {
    return handle(() => client.getInbox(request.params.agentId), reply);
  });

  app.post("/api/v1/messages/ack", async (request, reply) => {
    return handle(() => client.ackMessage(request.body), reply);
  });

  app.post("/api/v1/messages/broadcast", async (request, reply) => {
    return handle(() => client.broadcastMessage(request.body), reply);
  });

  app.get("/api/v1/models", async (_request, reply) => {
    return handle(() => client.getModels(), reply);
  });
}
