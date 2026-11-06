import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * The picontrol UI listeners. Each is a separate HTTP app that serves only an allowlist of module routes
 * (pimatrix, pivoice, piencoder, pitube) and nothing else. The role comes from the listener, never from a header:
 * - "lan": PIGATEWAY_UI_PORT on the LAN; operate routes and the setup routes marked `setup`.
 * - "relay": PIGATEWAY_UI_RELAY_PORT on 127.0.0.1, reached only through an ssh tunnel from a public relay; operate routes only.
 * Neither listener can reach the device config, the pitube RTMP ingest or the Canva/transcript routes.
 *
 * Module names match piecosystem repo names (e.g. pimatrix, pivoice, piencoder, pitube).
 */

export type UiRole = "lan" | "relay";
export type UiModule = "pimatrix" | "pivoice" | "piencoder" | "pitube" | "piradio" | "pisound" | "pitally" | "pigraphics" | "piprogram" | "pirundown";
export type UiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface UiRouteRule {
  method: UiMethod;
  /** Path template; `:name` matches one segment. */
  path: string;
  module: UiModule;
  /** Setup and configuration: offered on the LAN listener only. */
  setup?: boolean;
}

export const UI_ROUTES: readonly UiRouteRule[] = [
  { method: "GET", path: "/api/v1/matrix", module: "pimatrix" },
  { method: "POST", path: "/api/v1/matrix/route", module: "pimatrix" },
  { method: "PUT", path: "/api/v1/matrix/lock", module: "pimatrix" },
  { method: "GET", path: "/api/v1/activity/idle-close", module: "pivoice" },
  { method: "POST", path: "/api/v1/activity/session/start", module: "pivoice" },
  { method: "POST", path: "/api/v1/activity/session/stop", module: "pivoice" },
  { method: "PUT", path: "/api/v1/activity/idle-close", module: "pivoice", setup: true },
  { method: "GET", path: "/api/v1/voice/status", module: "pivoice" },
  { method: "GET", path: "/api/v1/voice/config", module: "pivoice" },
  { method: "PUT", path: "/api/v1/voice/config", module: "pivoice" },
  { method: "POST", path: "/api/v1/voice/capture", module: "pivoice" },
  { method: "POST", path: "/api/v1/voice/capture/start", module: "pivoice" },
  { method: "POST", path: "/api/v1/voice/capture/stop", module: "pivoice" },
  { method: "GET", path: "/api/v1/voice/transcripts", module: "pivoice" },
  { method: "GET", path: "/api/v1/voice/radio", module: "pivoice" },
  { method: "PUT", path: "/api/v1/voice/radio/:target/mode", module: "pivoice" },
  { method: "GET", path: "/api/v1/voice/captions", module: "pivoice" },
  { method: "GET", path: "/api/v1/transcripts", module: "pivoice" },
  { method: "GET", path: "/api/v1/encoders", module: "piencoder" },
  { method: "GET", path: "/api/v1/encoder/:number", module: "piencoder" },
  { method: "POST", path: "/api/v1/encoder/:number/start", module: "piencoder" },
  { method: "POST", path: "/api/v1/encoder/:number/stop", module: "piencoder" },
  { method: "PUT", path: "/api/v1/encoder/:number/settings", module: "piencoder", setup: true },
  { method: "GET", path: "/api/v1/status", module: "pitube" },
  { method: "GET", path: "/api/v1/broadcasts/current", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/start", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/stop", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/stop/request", module: "pitube" },
  { method: "GET", path: "/api/v1/radio-relay", module: "piradio" },
  { method: "GET", path: "/api/v1/radio-relay/stream", module: "piradio" },
  { method: "POST", path: "/api/v1/radio-relay/start", module: "piradio" },
  { method: "POST", path: "/api/v1/radio-relay/stop", module: "piradio" },
  // pimatrix video and composites
  { method: "GET", path: "/api/v1/sources", module: "pimatrix" },
  { method: "GET", path: "/api/v1/sources/:sourceId", module: "pimatrix" },
  { method: "GET", path: "/api/v1/outputs", module: "pimatrix" },
  { method: "POST", path: "/api/v1/outputs/:outputId/source", module: "pimatrix" },
  { method: "GET", path: "/api/v1/outputs/multiview", module: "pimatrix" },
  { method: "POST", path: "/api/v1/outputs/multiview/layout", module: "pimatrix" },
  { method: "POST", path: "/api/v1/outputs/multiview/slot", module: "pimatrix" },
  { method: "POST", path: "/api/v1/outputs/rtsp/source", module: "pimatrix" },
  { method: "POST", path: "/api/v1/outputs/rtsp/stream", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/crop", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/crop/preset", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/crop/move", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/crop/resize", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/ftb", module: "pimatrix" },
  { method: "POST", path: "/api/v1/sources/:sourceId/effects/mute", module: "pimatrix" },
  { method: "GET", path: "/api/v1/composites", module: "pimatrix" },
  { method: "GET", path: "/api/v1/composites/:id", module: "pimatrix" },
  { method: "GET", path: "/api/v1/composites/:id/preview.png", module: "pimatrix" },
  { method: "PUT", path: "/api/v1/composites/slide", module: "pimatrix" },
  { method: "POST", path: "/api/v1/composites/:id/start", module: "pimatrix" },
  { method: "POST", path: "/api/v1/composites/:id/stop", module: "pimatrix" },
  { method: "GET", path: "/api/v1/quick-options", module: "pimatrix" },
  { method: "POST", path: "/api/v1/quick-options/:id/apply", module: "pimatrix" },
  { method: "POST", path: "/api/v1/quick-options/number/:number/apply", module: "pimatrix" },

  // pisound mixer & channels
  { method: "GET", path: "/api/v1/mixes", module: "pisound" },
  { method: "GET", path: "/api/v1/mixes/:mixId", module: "pisound" },
  { method: "POST", path: "/api/v1/mixes/:mixId/master/volume", module: "pisound" },
  { method: "POST", path: "/api/v1/mixes/:mixId/master/mute", module: "pisound" },
  { method: "POST", path: "/api/v1/mixes/:mixId/channels/:channelId", module: "pisound" },
  { method: "POST", path: "/api/v1/mixes/:mixId/channels/:channelId/toggle", module: "pisound" },
  { method: "POST", path: "/api/v1/mics/:channelId/solo", module: "pisound" },
  { method: "POST", path: "/api/v1/mics/:channelId/mute", module: "pisound" },
  { method: "POST", path: "/api/v1/mics/:channelId/gain", module: "pisound" },
  { method: "POST", path: "/api/v1/reset", module: "pisound", setup: true },
  { method: "GET", path: "/api/v1/profiles", module: "pisound" },
  { method: "POST", path: "/api/v1/presets/:presetId/recall", module: "pisound" },
  { method: "GET", path: "/api/v1/sound/status", module: "pisound" },
  { method: "GET", path: "/api/v1/sound", module: "pisound" },

  // pitally lights
  { method: "GET", path: "/api/v1/lights", module: "pitally" },
  { method: "POST", path: "/api/v1/lights", module: "pitally" },
  { method: "GET", path: "/api/v1/lights/status", module: "pitally" },
  { method: "GET", path: "/api/v1/lights/:id", module: "pitally" },
  { method: "DELETE", path: "/api/v1/lights/:id", module: "pitally", setup: true },
  { method: "POST", path: "/api/v1/lights/:id/state", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/cue", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/call", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/hold", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/brightness", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/cycle", module: "pitally" },
  { method: "POST", path: "/api/v1/lights/:id/segments", module: "pitally", setup: true },

  // pitube broadcasts & streams
  { method: "GET", path: "/api/v1/broadcasts", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/select", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/create", module: "pitube" },
  { method: "PATCH", path: "/api/v1/broadcasts/:id", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/privacy", module: "pitube" },
  { method: "GET", path: "/api/v1/broadcasts/url", module: "pitube" },
  { method: "POST", path: "/api/v1/broadcasts/thumbnail", module: "pitube" },
  { method: "GET", path: "/api/v1/streams", module: "pitube" },
  { method: "POST", path: "/api/v1/streams/create", module: "pitube" },
  { method: "GET", path: "/api/v1/auth/health", module: "pitube" },
  { method: "POST", path: "/api/v1/auth/check", module: "pitube" },
  // pigraphics
  { method: "GET", path: "/api/v1/graphics/active", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/active/show", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/active/hide/:instanceId", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/active/clear", module: "pigraphics" },
  { method: "GET", path: "/api/v1/graphics/bindings", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/bindings", module: "pigraphics" },
  { method: "GET", path: "/api/v1/graphics/templates", module: "pigraphics" },
  { method: "GET", path: "/api/v1/graphics/templates/:id", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/templates", module: "pigraphics", setup: true },
  { method: "DELETE", path: "/api/v1/graphics/templates/:id", module: "pigraphics", setup: true },
  { method: "GET", path: "/api/v1/graphics/assets", module: "pigraphics" },
  { method: "GET", path: "/api/v1/graphics/assets/:id", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/assets", module: "pigraphics" },
  { method: "DELETE", path: "/api/v1/graphics/assets/:id", module: "pigraphics", setup: true },
  { method: "POST", path: "/api/v1/graphics/canva/push", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/canva/off-air", module: "pigraphics" },
  { method: "GET", path: "/api/v1/graphics/stream/status", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/stream/start", module: "pigraphics" },
  { method: "POST", path: "/api/v1/graphics/stream/stop", module: "pigraphics" },

  // piprogram
  { method: "GET", path: "/api/v1/pipgm/pipelines", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/pipelines/:pipelineId", module: "piprogram" },
  { method: "PUT", path: "/api/v1/pipgm/pipelines/:pipelineId", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/cue", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/step", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/play", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/pause", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/audio", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/audio/stop", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/audio/kill", module: "piprogram" },
  { method: "PUT", path: "/api/v1/pipgm/pipelines/:pipelineId/playlist", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/pipelines/:pipelineId/playlist", module: "piprogram" },
  { method: "DELETE", path: "/api/v1/pipgm/pipelines/:pipelineId/playlist/:itemId", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/items", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/items/:itemId", module: "piprogram" },
  { method: "DELETE", path: "/api/v1/pipgm/items/:itemId", module: "piprogram", setup: true },
  { method: "POST", path: "/api/v1/pipgm/items/canva", module: "piprogram" },
  { method: "PUT", path: "/api/v1/pipgm/items/:itemId/use-at", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/items/:itemId/package", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/tasks/:taskId", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/items/:itemId/steps", module: "piprogram" },
  { method: "POST", path: "/api/v1/pipgm/items/:itemId/prepare", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/feeders", module: "piprogram" },
  { method: "GET", path: "/api/v1/pipgm/library/storage", module: "piprogram" },

  // pirundown-designer
  { method: "GET", path: "/api/v1/designer/state", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/state", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/items", module: "pirundown" },
  { method: "PUT", path: "/api/v1/designer/items/:id", module: "pirundown" },
  { method: "DELETE", path: "/api/v1/designer/items/:id", module: "pirundown" },
  { method: "PATCH", path: "/api/v1/designer/metadata", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/template", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/agent/chat", module: "pirundown" },
  { method: "GET", path: "/api/v1/designer/templates", module: "pirundown" },
  { method: "GET", path: "/api/v1/designer/templates/:id", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/validate", module: "pirundown" },
  { method: "POST", path: "/api/v1/designer/push", module: "pirundown" },
];

interface CompiledRule extends UiRouteRule {
  pattern: RegExp;
}

const COMPILED: CompiledRule[] = UI_ROUTES.map((rule) => ({
  ...rule,
  pattern: new RegExp(`^${rule.path.replace(/:[^/]+/g, "[^/]+")}$`)
}));

function isModuleAllowed(ruleModule: string, allowedModules: ReadonlySet<string>): boolean {
  if (allowedModules.has(ruleModule)) return true;
  const aliasMap: Record<string, string> = {
    pimatrix: "matrix",
    matrix: "pimatrix",
    pivoice: "voice",
    voice: "pivoice",
    pitube: "stream",
    stream: "pitube",
    piencoder: "outputs",
    outputs: "piencoder",
    piradio: "radio",
    radio: "piradio",
    pisound: "sound",
    sound: "pisound",
    pitally: "tally",
    tally: "pitally",
    lights: "pitally",
    pigraphics: "graphics",
    graphics: "pigraphics",
    piprogram: "pipgm",
    pipgm: "piprogram",
    program: "piprogram",
    pirundown: "rundown",
    rundown: "pirundown",
    designer: "pirundown",
  };
  const alias = aliasMap[ruleModule];
  return Boolean(alias && allowedModules.has(alias));
}

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
  /** Cookie SameSite. "Strict" for the LAN; "None" for the relay, whose page is served from another site (needs Secure). */
  sameSite?: "Strict" | "None";
  /** Set the Secure flag on the session cookie (required with SameSite=None). */
  secure?: boolean;
  /** Pause after a wrong PIN, to slow guessing. */
  failDelayMs?: number;
}

/** PIN login. Only a SHA-256 digest of the PIN is kept; sessions live in memory (a restart asks for the PIN again). */
export function createPinAuth(options: PinAuthOptions): UiAuthAdapter {
  const pinDigest = sha256(options.pin);
  const sessions = new Map<string, number>();
  const now = options.now ?? Date.now;
  const failDelayMs = options.failDelayMs ?? 600;
  const sameSite = options.sameSite ?? "Strict";
  const secureFlag = options.secure || sameSite === "None" ? "; Secure" : "";
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
    cookie: (token) => `${UI_COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}${secureFlag}; Max-Age=${SESSION_MS / 1000}`,
    clearCookie: () => `${UI_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}${secureFlag}; Max-Age=0`
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
  /** Modules this listener serves; undefined = all. A route of a module not in the set answers 404. */
  modules?: ReadonlySet<string> | undefined;
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
      if (!rule || (options.modules && !isModuleAllowed(rule.module, options.modules))) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not available on the picontrol UI" } });
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
