import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * The picontrol UI listeners. Each is a separate HTTP app that serves only an allowlist of module routes
 * (matrix, pivoice, piencoder, pitube) and nothing else. The role comes from the listener, never from a header:
 * - "lan": PIGATEWAY_UI_PORT on the LAN; operate routes and the setup routes marked `setup`.
 * - "relay": PIGATEWAY_UI_RELAY_PORT on 127.0.0.1, reached only through an ssh tunnel from a public relay; operate routes only.
 * Neither listener can reach the device config, the pitube RTMP ingest or the Canva/transcript routes.
 */

export type UiRole = "lan" | "relay";
export type UiModule = "matrix" | "pivoice" | "piencoder" | "pitube";
export type UiMethod = "GET" | "POST" | "PUT";

export interface UiRouteRule {
  method: UiMethod;
  /** Path template; `:name` matches one segment. */
  path: string;
  module: UiModule;
  /** Setup and configuration: offered on the LAN listener only. */
  setup?: boolean;
}

export const UI_ROUTES: readonly UiRouteRule[] = [
  { method: "GET", path: "/api/v1/matrix", module: "matrix" },
  { method: "POST", path: "/api/v1/matrix/route", module: "matrix" },
  { method: "PUT", path: "/api/v1/matrix/lock", module: "matrix" },
  { method: "GET", path: "/api/v1/activity/idle-close", module: "pivoice" },
  { method: "POST", path: "/api/v1/activity/session/start", module: "pivoice" },
  { method: "POST", path: "/api/v1/activity/session/stop", module: "pivoice" },
  { method: "PUT", path: "/api/v1/activity/idle-close", module: "pivoice", setup: true },
  { method: "GET", path: "/api/v1/encoders", module: "piencoder" },
  { method: "GET", path: "/api/v1/encoder/:number", module: "piencoder" },
  { method: "POST", path: "/api/v1/encoder/:number/start", module: "piencoder" },
  { method: "POST", path: "/api/v1/encoder/:number/stop", module: "piencoder" },
  { method: "PUT", path: "/api/v1/encoder/:number/settings", module: "piencoder", setup: true },
  { method: "GET", path: "/api/v1/status", module: "pitube" },
  { method: "GET", path: "/api/v1/broadcasts/current", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/start", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/stop", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/stop/request", module: "pitube" }
];

interface CompiledRule extends UiRouteRule {
  pattern: RegExp;
}

const COMPILED: CompiledRule[] = UI_ROUTES.map((rule) => ({
  ...rule,
  pattern: new RegExp(`^${rule.path.replace(/:[^/]+/g, "[^/]+")}$`)
}));

/** The rule for a request, or null when the path/method is not on the allowlist. */
export function findUiRoute(method: string, url: string): UiRouteRule | null {
  const path = url.split("?")[0] ?? "";
  const hit = COMPILED.find((rule) => rule.method === method && rule.pattern.test(path));
  return hit ? { method: hit.method, path: hit.path, module: hit.module, ...(hit.setup ? { setup: true } : {}) } : null;
}

/** Who a request is. Replaceable: the PIN adapter now, an OIDC adapter later. */
export interface UiAuthAdapter {
  /** A session token for valid credentials, or null. Wrong credentials are slowed down by the adapter. */
  login(credentials: { pin?: unknown }): Promise<string | null>;
  /** The request's role when it carries a valid session, else null. */
  authenticate(request: FastifyRequest, listenerRole: UiRole): { role: UiRole } | null;
  logout(request: FastifyRequest): void;
  /** Set-Cookie value for a session token, and the cookie that clears it. */
  cookie(token: string): string;
  clearCookie(): string;
}

/** No PIN: every request is the listener's role. Only for a LAN listener that is trusted (PIGATEWAY_UI_LAN_NO_PIN=true). */
export function createOpenAuth(): UiAuthAdapter {
  return {
    async login() {
      return "";
    },
    authenticate(_request, listenerRole) {
      return { role: listenerRole };
    },
    logout() {
      // nothing to end
    },
    cookie: () => "",
    clearCookie: () => ""
  };
}

export const UI_COOKIE = "picontrol_ui";
const SESSION_MS = 12 * 60 * 60 * 1000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export interface PinAuthOptions {
  pin: string;
  now?: () => number;
  /** Pause after a wrong PIN, to slow guessing. */
  failDelayMs?: number;
}

/** PIN login. Only a SHA-256 digest of the PIN is kept; sessions live in memory (a restart asks for the PIN again). */
export function createPinAuth(options: PinAuthOptions): UiAuthAdapter {
  const pinDigest = sha256(options.pin);
  const sessions = new Map<string, number>();
  const now = options.now ?? Date.now;
  const failDelayMs = options.failDelayMs ?? 600;
  return {
    async login(credentials) {
      const given = typeof credentials.pin === "string" ? sha256(credentials.pin) : null;
      if (!given || !timingSafeEqual(given, pinDigest)) {
        await new Promise((resolve) => setTimeout(resolve, failDelayMs));
        return null;
      }
      const token = randomBytes(32).toString("base64url");
      sessions.set(sha256(token).toString("hex"), now() + SESSION_MS);
      return token;
    },
    authenticate(request, listenerRole) {
      const token = cookieValue(request, UI_COOKIE);
      if (!token) return null;
      const key = sha256(token).toString("hex");
      const expires = sessions.get(key);
      if (expires === undefined) return null;
      if (expires < now()) {
        sessions.delete(key);
        return null;
      }
      return { role: listenerRole };
    },
    logout(request) {
      const token = cookieValue(request, UI_COOKIE);
      if (token) sessions.delete(sha256(token).toString("hex"));
    },
    cookie: (token) => `${UI_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
    clearCookie: () => `${UI_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  };
}

export interface ForwardedResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

/** Runs an allowlisted request: in-process for gateway routes, over HTTP for upstream modules (pitube). */
export type UiForward = (rule: UiRouteRule, request: { method: UiMethod; url: string; body: unknown }) => Promise<ForwardedResponse>;

export interface UiListenerOptions {
  role: UiRole;
  auth: UiAuthAdapter;
  forward: UiForward;
  corsOrigins?: string[] | undefined;
  logger: FastifyBaseLogger;
}

/** Builds one UI listener app. The caller listens on it (LAN: 0.0.0.0, relay: 127.0.0.1). */
export function buildUiListener(options: UiListenerOptions): FastifyInstance {
  const app = Fastify({ trustProxy: false, loggerInstance: options.logger.child({ component: `ui-${options.role}` }), disableRequestLogging: true, bodyLimit: 256 * 1024 });
  const allowedOrigins = new Set(options.corsOrigins ?? []);
  const originFor = (origin: string | undefined): string | null => (origin && allowedOrigins.has(origin) ? origin : null);

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS") return;
    const allowed = originFor(request.headers.origin);
    if (!allowed) return reply.code(403).send();
    return reply
      .code(204)
      .header("Access-Control-Allow-Origin", allowed)
      .header("Access-Control-Allow-Credentials", "true")
      .header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
      .header("Access-Control-Allow-Headers", "Content-Type")
      .header("Access-Control-Max-Age", "600")
      .header("Vary", "Origin")
      .send();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Vary", "Origin");
    const allowed = originFor(request.headers.origin);
    if (allowed) {
      reply.header("Access-Control-Allow-Origin", allowed);
      reply.header("Access-Control-Allow-Credentials", "true");
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ event: "http_request", method: request.method, route: request.routeOptions?.url ?? "(unmatched)", status: reply.statusCode }, "request");
  });

  app.get("/health", async () => ({ ok: true, role: options.role }));

  app.post<{ Body: { pin?: unknown } | undefined }>("/ui/api/login", async (request, reply) => {
    const token = await options.auth.login(request.body ?? {});
    if (!token) return reply.code(401).send({ error: { code: "WRONG_PIN", message: "Wrong PIN" } });
    return reply.header("Set-Cookie", options.auth.cookie(token)).send({ role: options.role });
  });
  app.post("/ui/api/logout", async (request, reply) => {
    options.auth.logout(request);
    return reply.header("Set-Cookie", options.auth.clearCookie()).send({ ok: true });
  });
  app.get("/ui/api/session", async (request, reply) => {
    const session = options.auth.authenticate(request, options.role);
    if (!session) return reply.code(401).send({ error: { code: "LOGIN_REQUIRED", message: "Log in with the PIN" } });
    return { role: session.role };
  });

  // Module routes. Anything not on the allowlist answers 404, so the listener does not describe the gateway.
  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/api/v1/*",
    handler: async (request, reply) => {
      const rule = findUiRoute(request.method, request.url);
      if (!rule) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not available on the picontrol UI" } });
      if (!options.auth.authenticate(request, options.role)) {
        return reply.code(401).send({ error: { code: "LOGIN_REQUIRED", message: "Log in with the PIN" } });
      }
      if (rule.setup && options.role !== "lan") {
        return reply.code(403).send({ error: { code: "SETUP_NOT_ON_THIS_LISTENER", message: "Setup is not available through the internet relay" } });
      }
      const forwarded = await options.forward(rule, { method: request.method as UiMethod, url: request.url, body: request.body });
      return reply.code(forwarded.statusCode).type(forwarded.contentType).send(forwarded.body);
    }
  });

  return app;
}
