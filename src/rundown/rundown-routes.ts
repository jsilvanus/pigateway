import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RundownStore, StoredRundownDoc } from "./rundown-store.js";

function getActor(req: FastifyRequest, body?: any): string {
  if (typeof body?.actor === "string" && body.actor.trim()) {
    return body.actor.trim();
  }
  const header = req.headers["x-actor"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  return "unknown";
}

export function registerRundownRoutes(app: FastifyInstance, store: RundownStore): void {
  // 1. GET /api/v1/rundown - Current snapshot
  app.get("/api/v1/rundown", async () => {
    return store.getStatus();
  });

  // 2. POST /api/v1/rundown/load - Load a new rundown document
  app.post<{ Body: StoredRundownDoc | { doc: StoredRundownDoc; actor?: string } }>(
    "/api/v1/rundown/load",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object") {
        return reply.status(400).send({ error: "Missing JSON body" });
      }

      const doc: StoredRundownDoc = "doc" in body && body.doc ? body.doc : (body as StoredRundownDoc);
      if (!doc.title || !Array.isArray(doc.rundown)) {
        return reply.status(422).send({ error: "Invalid rundown document: must have 'title' and 'rundown' array" });
      }

      const actor = getActor(req, body);
      const snapshot = store.load(doc, actor);
      return { ok: true, rundown: snapshot };
    }
  );

  // 3. POST /api/v1/rundown/reset - Reset to beginning
  app.post<{ Body?: { actor?: string } }>("/api/v1/rundown/reset", async (req) => {
    const actor = getActor(req, req.body);
    const snapshot = store.reset(actor);
    return { ok: true, rundown: snapshot };
  });

  // 4. POST /api/v1/rundown/next - Step to next item
  app.post<{ Body?: { actor?: string } }>("/api/v1/rundown/next", async (req) => {
    const actor = getActor(req, req.body);
    const result = await store.next(actor);
    return { ok: true, advanced: result.advanced, rundown: result.rundown };
  });

  // 5. POST /api/v1/rundown/previous - Step to previous item
  app.post<{ Body?: { actor?: string } }>("/api/v1/rundown/previous", async (req) => {
    const actor = getActor(req, req.body);
    const result = store.previous(actor);
    return { ok: true, moved: result.moved, rundown: result.rundown };
  });

  // 6. POST /api/v1/rundown/goto/:id - Jump to specific item
  app.post<{ Params: { id: string }; Body?: { actor?: string } }>(
    "/api/v1/rundown/goto/:id",
    async (req, reply) => {
      const actor = getActor(req, req.body);
      const result = store.goto(req.params.id, actor);
      if (!result.moved) {
        return reply.status(404).send({ error: `Rundown item '${req.params.id}' not found` });
      }
      return { ok: true, rundown: result.rundown };
    }
  );

  // 7. POST /api/v1/rundown/skip - Skip item
  app.post<{ Body?: { id?: string; actor?: string } }>("/api/v1/rundown/skip", async (req, reply) => {
    const actor = getActor(req, req.body);
    const result = store.skip(req.body?.id, actor);
    if (!result.skipped) {
      return reply.status(404).send({ error: "Item not found or cannot be skipped" });
    }
    return { ok: true, rundown: result.rundown };
  });

  // 8. POST /api/v1/rundown/fire/:id - Fire cue & execute actions for item
  app.post<{ Params: { id: string }; Body?: { actor?: string } }>(
    "/api/v1/rundown/fire/:id",
    async (req, reply) => {
      const actor = getActor(req, req.body);
      const result = await store.fire(req.params.id, actor);
      if (!result.ok) {
        return reply.status(404).send({ error: `Rundown item '${req.params.id}' not found` });
      }
      return { ok: true, executed: result.executed, rundown: result.rundown };
    }
  );

  // 9. GET /api/v1/rundown/variables - List variables
  app.get("/api/v1/rundown/variables", async () => {
    return { variables: store.getVariables() };
  });

  // 10. POST /api/v1/rundown/variables - Set a variable
  app.post<{ Body: { name: string; value: string; actor?: string } }>(
    "/api/v1/rundown/variables",
    async (req, reply) => {
      const { name, value } = req.body ?? {};
      if (!name) {
        return reply.status(400).send({ error: "Missing variable 'name'" });
      }
      const actor = getActor(req, req.body);
      store.setVariable(name, String(value ?? ""), actor);
      return { ok: true, variables: store.getVariables() };
    }
  );
}
