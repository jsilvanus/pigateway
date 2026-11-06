import type { FastifyInstance } from "fastify";
import type { PiMatrixClient } from "./client.js";

export function registerMatrixProxyRoutes(
  app: FastifyInstance,
  { client }: { client: PiMatrixClient }
): void {
  // 1. Sources
  app.get("/api/v1/sources", async (_request, reply) => {
    try {
      return await client.getSources();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.get<{ Params: { sourceId: string } }>("/api/v1/sources/:sourceId", async (request, reply) => {
    try {
      return await client.getSource(request.params.sourceId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 2. Outputs
  app.get("/api/v1/outputs", async (_request, reply) => {
    try {
      return await client.getOutputs();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { outputId: string }; Body: unknown }>("/api/v1/outputs/:outputId/source", async (request, reply) => {
    try {
      return await client.setOutputSource(request.params.outputId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 3. Multiview
  app.get("/api/v1/outputs/multiview", async (_request, reply) => {
    try {
      return await client.getMultiviewLayout();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/outputs/multiview/layout", async (request, reply) => {
    try {
      return await client.setMultiviewLayout(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/outputs/multiview/slot", async (request, reply) => {
    try {
      return await client.setMultiviewSlot(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 4. RTSP Output
  app.post("/api/v1/outputs/rtsp/source", async (request, reply) => {
    try {
      return await client.setRtspSource(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/outputs/rtsp/stream", async (request, reply) => {
    try {
      return await client.setRtspStream(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 5. Effects & Crops
  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/crop", async (request, reply) => {
    try {
      return await client.setCrop(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/crop/preset", async (request, reply) => {
    try {
      return await client.setCropPreset(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/crop/move", async (request, reply) => {
    try {
      return await client.moveCrop(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/crop/resize", async (request, reply) => {
    try {
      return await client.resizeCrop(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/ftb", async (request, reply) => {
    try {
      return await client.setFtb(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { sourceId: string }; Body: unknown }>("/api/v1/sources/:sourceId/effects/mute", async (request, reply) => {
    try {
      return await client.setMute(request.params.sourceId, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 6. Composites
  app.get("/api/v1/composites", async (_request, reply) => {
    try {
      return await client.getComposites();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/composites/:id", async (request, reply) => {
    try {
      return await client.getComposite(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/composites/:id/preview.png", async (request, reply) => {
    try {
      const buf = await client.getCompositePreview(request.params.id);
      return reply.type("image/png").send(buf);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.put("/api/v1/composites/slide", async (request, reply) => {
    try {
      const contentType = String(request.headers["content-type"] ?? "image/png").split(";")[0]!.trim();
      const body = request.body;
      if (!(body instanceof Uint8Array) && !(body instanceof Buffer)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Raw binary image required" } });
      }
      return await client.setSlide(body, contentType);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/composites/:id/start", async (request, reply) => {
    try {
      return await client.startComposite(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/composites/:id/stop", async (request, reply) => {
    try {
      return await client.stopComposite(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  // 7. Quick Options
  app.get("/api/v1/quick-options", async (_request, reply) => {
    try {
      return await client.getQuickOptions();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/quick-options/:id/apply", async (request, reply) => {
    try {
      return await client.applyQuickOption(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });

  app.post<{ Params: { number: string } }>("/api/v1/quick-options/number/:number/apply", async (request, reply) => {
    try {
      const num = parseInt(request.params.number, 10);
      if (isNaN(num)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "number must be an integer" } });
      }
      return await client.applyQuickOptionNumber(num);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pimatrix_unavailable", message: error.message } });
    }
  });
}
