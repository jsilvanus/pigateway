import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerCanvaRoutes, type CanvaRoutesOptions } from "./canva-routes.js";
import type { CanvaService } from "./canva-service.js";
import { CanvaTeamNotAllowed, type CanvaUserAuth } from "./canva-user-auth.js";
import { effectiveRights, hasRight, rightsForGroups, type GroupRights, type Level } from "../auth/rights.js";
import { peekIssuer, TunnusAuthError, type TunnusVerifier } from "../auth/tunnus.js";

/** Who a request is, once it has passed the listener's auth. Tunnus sessions carry rights from groups; keys and Canva user tokens are full access as before. */
export interface CanvaSession {
  auth: "tunnus" | "canva-user" | "key";
  sub?: string | undefined;
  name?: string | undefined;
  /** Canva user token: the Canva team the token was issued for. */
  brandId?: string | undefined;
  rights: Set<string>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The Canva-only listener (see buildCanvaTunnelApp); set when PIGATEWAY_CANVA_TUNNEL_PORT is configured. */
    canvaTunnel?: FastifyInstance;
  }
  interface FastifyRequest {
    canvaSession?: CanvaSession | undefined;
  }
}

/** Rights a shared key or a Canva user token gets: everything on the canva module, as before Tunnus. */
const FULL_CANVA_RIGHTS = ["canva:read", "canva:write", "canva:operate"];

/** Steps of a saved action list that only prepare content. Any other step puts something live, which needs canva:operate. */
const CONTENT_STEPS = new Set(["pipgm:playlist-set"]);

function actionListLevel(body: unknown): Level {
  const steps = (body as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return "write";
  return steps.every((s) => typeof (s as { action?: unknown } | null)?.action === "string" && CONTENT_STEPS.has((s as { action: string }).action)) ? "write" : "operate";
}

/**
 * The right each Canva route needs, by `METHOD route`. Presentation controls and projector routing are operate; sending slides and
 * saving playlists and lists is write. A route that is not here is refused (default deny), so a new route is never open by accident.
 * Cameras and the rest of the gateway are not on this listener at all.
 */
const ROUTE_LEVEL: Record<string, Level | ((body: unknown) => Level)> = {
  "GET /api/v1/canva/session": "read",
  "GET /api/v1/canva/status": "read",
  "GET /api/v1/canva/tasks/:taskId": "read",
  "GET /api/v1/canva/action-lists/:id": "read",
  "POST /api/v1/canva/push": "write",
  "POST /api/v1/canva/action-lists": actionListLevel,
  "POST /api/v1/canva/setup": "operate",
  "POST /api/v1/canva/control": "operate"
};

export interface CanvaTunnelConfig {
  apiKey?: string | undefined;
  /** Browser origins allowed to call the listener (the Canva app's origin). Nothing else gets CORS headers. */
  corsOrigins?: string[] | undefined;
  /** Accepts a Canva user token (a JWT) from an allowed team instead of the shared key. Optional. */
  userAuth?: CanvaUserAuth | undefined;
  /** Accepts a Tunnus access token (aud contains this gateway) and maps its groups to rights. Off unless set. */
  tunnus?: { verifier: TunnusVerifier; groupRights: GroupRights } | undefined;
  /** Whether the shared PIGATEWAY_API_KEY still opens the listener. Default true; set false once people sign in with Tunnus. */
  allowApiKey?: boolean | undefined;
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
    const keyAllowed = Boolean(config.apiKey) && config.allowApiKey !== false;
    if (!keyAllowed && !config.userAuth && !config.tunnus) {
      return reply.code(503).send({ error: { code: "TUNNEL_NOT_CONFIGURED", message: "Set PIGATEWAY_API_KEY, PIGATEWAY_CANVA_APP_ID or Tunnus sign-in" } });
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"].trim()
        : undefined;
    if (config.tunnus && token && looksLikeJwt(token) && peekIssuer(token) === config.tunnus.verifier.issuer) {
      try {
        const claims = await config.tunnus.verifier.verify(token);
        const rights = rightsForGroups(config.tunnus.groupRights, claims.groups);
        if (!hasRight(rights, "canva", "read")) {
          request.log.warn({ event: "canva_no_access", sub: claims.sub }, "Tunnus user has no canva right");
          return reply.code(403).send({ error: { code: "NO_ACCESS", message: "Your groups give no access to the Canva listener" } });
        }
        request.canvaSession = { auth: "tunnus", sub: claims.sub, name: claims.name, rights };
        return;
      } catch (err) {
        if (err instanceof TunnusAuthError && err.code === "JWKS_UNAVAILABLE") {
          return reply.code(503).send({ error: { code: "SIGN_IN_UNAVAILABLE", message: "Cannot check the sign-in right now" } });
        }
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Sign-in token is not valid" } });
      }
    }
    if (config.userAuth && token && looksLikeJwt(token)) {
      try {
        const user = await config.userAuth.verify(token);
        request.canvaSession = { auth: "canva-user", sub: user.userId, brandId: user.brandId, rights: new Set(FULL_CANVA_RIGHTS) };
        return;
      } catch (err) {
        if (err instanceof CanvaTeamNotAllowed) {
          // The team id is not a secret: logging it lets the operator add the church's team to the allow-list.
          request.log.warn({ event: "canva_team_refused", brandId: err.brandId }, "Canva team not on PIGATEWAY_CANVA_ALLOWED_BRANDS");
          return reply.code(403).send({ error: { code: "TEAM_NOT_ALLOWED", message: "This Canva team may not use the gateway" } });
        }
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Canva user token is not valid" } });
      }
    }
    if (!keyAllowed || !sameKey(token, config.apiKey!)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or Bearer token required" } });
    }
    request.canvaSession = { auth: "key", rights: new Set(FULL_CANVA_RIGHTS) };
  });
  // Rights check once the body is parsed (an action list's level depends on its steps). Keys and Canva user tokens hold every canva right.
  app.addHook("preHandler", async (request, reply) => {
    const session = request.canvaSession;
    if (!session || session.auth !== "tunnus") return;
    const rule = ROUTE_LEVEL[`${request.method} ${request.routeOptions?.url ?? ""}`];
    const level = typeof rule === "function" ? rule(request.body) : rule;
    if (!level || !hasRight(session.rights, "canva", level)) {
      request.log.warn({ event: "canva_right_refused", sub: session.sub, route: request.routeOptions?.url, needs: level ? `canva:${level}` : "no rule" }, "right missing");
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: level ? `This needs the canva:${level} right` : "This route is not available" } });
    }
  });
  app.get("/api/v1/canva/session", async (request) => {
    const session = request.canvaSession;
    return { auth: session?.auth ?? null, name: session?.name ?? null, rights: session ? effectiveRights(session.rights, "canva") : [] };
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const allowed = originFor(request.headers.origin);
    reply.header("Vary", "Origin");
    if (allowed) reply.header("Access-Control-Allow-Origin", allowed);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    // Who and how, never the token: auth method, sub/name (Tunnus) or user and team id (Canva), and the granted canva rights.
    const session = request.canvaSession;
    request.log.info({
      event: "http_request", method: request.method, route: request.routeOptions?.url ?? "(unmatched)", status: reply.statusCode,
      ...(session ? { auth: session.auth, sub: session.sub, name: session.name, brandId: session.brandId, rights: effectiveRights(session.rights, "canva") } : {})
    }, "request");
  });

  registerCanvaRoutes(app, service, routeOptions);
  return app;
}
