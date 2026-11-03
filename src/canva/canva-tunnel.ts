import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerCanvaRoutes, type CanvaRoutesOptions } from "./canva-routes.js";
import type { CanvaService } from "./canva-service.js";
import { CanvaTeamNotAllowed, type CanvaUserAuth } from "./canva-user-auth.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The Canva-only listener (see buildCanvaTunnelApp); set when PIGATEWAY_CANVA_TUNNEL_PORT is configured. */
    canvaTunnel?: FastifyInstance;
  }
}

export interface CanvaTunnelConfig {
  apiKey?: string | undefined;
  /** Browser origins allowed to call the listener (the Canva app's origin). Nothing else gets CORS headers. */
  corsOrigins?: string[] | undefined;
  /** Accepts a Canva user token (a JWT) from an allowed team instead of the shared key. Optional. */
  userAuth?: CanvaUserAuth | undefined;
}

/** A Canva user token is a JWT: three dot-separated parts. The shared key is never shaped like one. */
function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function sameKey(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A second, separate HTTP app that serves only /api/v1/canva/*, meant to be reached through an ssh tunnel from
 * a public reverse proxy. Through a tunnel every caller looks like 127.0.0.1, so unlike the main app it
 * ignores the allowed-hosts list and forwarded headers: every request (reads too) needs the API key, and
 * without a key configured it answers 503. It shares the CanvaService and routes with the main app.
 */
export function buildCanvaTunnelApp(
  config: CanvaTunnelConfig,
  service: CanvaService,
  routeOptions: CanvaRoutesOptions,
  logger: FastifyBaseLogger
): FastifyInstance {
  const app = Fastify({ trustProxy: false, loggerInstance: logger.child({ component: "canva-tunnel" }), disableRequestLogging: true, bodyLimit: 1024 * 1024 });
  const allowedOrigins = new Set(config.corsOrigins ?? []);
  const originFor = (origin: string | undefined): string | null => (origin && allowedOrigins.has(origin) ? origin : null);

  app.addHook("onRequest", async (request, reply) => {
    const allowed = originFor(request.headers.origin);
    if (request.method === "OPTIONS") {
      if (!allowed) return reply.code(403).send();
      return reply
        .code(204)
        .header("Access-Control-Allow-Origin", allowed)
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key")
        .header("Access-Control-Max-Age", "600")
        .header("Vary", "Origin")
        .send();
    }
    if (!config.apiKey && !config.userAuth) {
      return reply.code(503).send({ error: { code: "TUNNEL_NOT_CONFIGURED", message: "Set PIGATEWAY_API_KEY or PIGATEWAY_CANVA_APP_ID" } });
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"].trim()
        : undefined;
    if (config.userAuth && token && looksLikeJwt(token)) {
      try {
        await config.userAuth.verify(token);
        return;
      } catch (err) {
        if (err instanceof CanvaTeamNotAllowed) {
          return reply.code(403).send({ error: { code: "TEAM_NOT_ALLOWED", message: "This Canva team may not use the gateway" } });
        }
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Canva user token is not valid" } });
      }
    }
    if (!config.apiKey || !sameKey(token, config.apiKey)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or Bearer token required" } });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const allowed = originFor(request.headers.origin);
    reply.header("Vary", "Origin");
    if (allowed) reply.header("Access-Control-Allow-Origin", allowed);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ event: "http_request", method: request.method, route: request.routeOptions?.url ?? "(unmatched)", status: reply.statusCode }, "request");
  });

  registerCanvaRoutes(app, service, routeOptions);
  return app;
}
