/** HTTP routes for the YouTube live status that pitube reports. Writes go through the API auth hook. */

import type { FastifyInstance } from "fastify";
import { parseYoutubeStatus, type YoutubeStatusStore } from "./youtube-status.js";

export function registerYoutubeRoutes(app: FastifyInstance, store: YoutubeStatusStore): void {
  app.get("/api/v1/youtube", async () => store.get());

  app.put<{ Body: unknown }>("/api/v1/youtube/status", async (request, reply) => {
    const parsed = parseYoutubeStatus(request.body);
    if (!parsed.ok) {
      return reply.code(422).send({ error: { code: "INVALID_INPUT", message: parsed.message } });
    }
    return store.set(parsed.value);
  });
}
