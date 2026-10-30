import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

export interface RundownRoutesOptions {
  pirundownUrl?: string;
  fetchFn?: typeof fetch;
}

export function registerRundownRoutes(
  app: FastifyInstance,
  store: RundownStore,
  options: RundownRoutesOptions = {}
): void {
  const pirundownUrl = (options.pirundownUrl ?? "http://127.0.0.1:3400").replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;

  // 1. GET /api/v1/rundown - Current snapshot
  app.get("/api/v1/rundown", async () => {
    return store.getStatus();
  });

  // 2. POST /api/v1/rundown/load - Load a new rundown document (JSON doc or { yaml: string })
  app.post<{ Body: any }>(
    "/api/v1/rundown/load",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object") {
        return reply.status(400).send({ error: "Missing JSON body" });
      }

      const actor = getActor(req, body);

      // Support YAML string payload forwarded to PiRundown
      if (typeof body.yaml === "string") {
        try {
          const pirundownRes = await fetchFn(`${pirundownUrl}/api/v1/rundown/load`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yaml: body.yaml }),
          });
          const pirundownData = (await pirundownRes.json()) as any;
          if (!pirundownRes.ok) {
            return reply.status(pirundownRes.status).send(pirundownData);
          }
          if (pirundownData.rundown?.raw) {
            store.load(pirundownData.rundown.raw, actor);
          }
          return { ok: true, rundown: store.getStatus(), pirundown: pirundownData };
        } catch (err: any) {
          return reply.status(502).send({ error: `Cannot forward to pirundown: ${err.message}` });
        }
      }

      const doc: StoredRundownDoc = "doc" in body && body.doc ? body.doc : (body as StoredRundownDoc);
      if (!doc.title || !Array.isArray(doc.rundown)) {
        return reply.status(422).send({ error: "Invalid rundown document: must have 'title' and 'rundown' array" });
      }

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

  // 8. POST /api/v1/rundown/fire - Fire current item or item specified in body
  app.post<{ Body?: { target?: string | number; line?: number; index?: number; id?: string; actor?: string } }>(
    "/api/v1/rundown/fire",
    async (req, reply) => {
      const body = req.body;
      const target = body?.line !== undefined ? body.line : body?.index !== undefined ? { index: body.index } : body?.id ?? body?.target;
      const actor = getActor(req, body);
      const result = await store.fire(target, actor);
      if (!result.ok) {
        return reply.status(404).send({ error: "Rundown item not found or out of bounds" });
      }
      return { ok: true, executed: result.executed, rundown: result.rundown };
    }
  );

  // 9. POST /api/v1/rundown/fire/:id - Fire cue & execute actions for item or line
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

  // 10. GET /api/v1/rundown/variables - List variables
  app.get("/api/v1/rundown/variables", async () => {
    return { variables: store.getVariables() };
  });

  // 11. POST /api/v1/rundown/variables - Set a variable
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

  // 12. Storage Proxies for PiRundown (Internet / Gateway ingress)
  const proxyStorage = async (path: string, req: FastifyRequest, reply: FastifyReply, method: string = "GET", body?: any) => {
    try {
      const res = await fetchFn(`${pirundownUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const text = await res.text();
      reply.type("application/json").status(res.status).send(text);
    } catch (err: any) {
      reply.status(502).send({ ok: false, error: `PiGateway: Cannot reach PiRundown at ${pirundownUrl}: ${err.message}` });
    }
  };

  app.get("/api/v1/rundown/storage", async (req, reply) => {
    await proxyStorage("/api/v1/storage", req, reply);
  });

  app.get("/api/v1/storage/rundowns", async (req, reply) => {
    await proxyStorage("/api/v1/storage", req, reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/rundown/storage/:id", async (req, reply) => {
    await proxyStorage(`/api/v1/storage/${req.params.id}`, req, reply);
  });

  app.post<{ Body: any }>("/api/v1/rundown/storage", async (req, reply) => {
    await proxyStorage("/api/v1/storage", req, reply, "POST", req.body);
  });

  app.post<{ Params: { id: string } }>("/api/v1/rundown/storage/:id/load", async (req, reply) => {
    await proxyStorage(`/api/v1/storage/${req.params.id}/load`, req, reply, "POST");
  });

  app.delete<{ Params: { id: string } }>("/api/v1/rundown/storage/:id", async (req, reply) => {
    await proxyStorage(`/api/v1/storage/${req.params.id}`, req, reply, "DELETE");
  });
}
