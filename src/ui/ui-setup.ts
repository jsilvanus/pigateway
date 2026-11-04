import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { buildUiListener, createOpenAuth, createPinAuth, type ForwardedResponse, type UiForward, type UiMethod, type UiRole, type UiRouteRule } from "./ui-listener.js";

export interface UiListenerSpec {
  role: UiRole;
  host: string;
  port: number;
  app: FastifyInstance;
}

const JSON_TYPE = "application/json; charset=utf-8";

function notConfigured(module: string): ForwardedResponse {
  return { statusCode: 503, contentType: JSON_TYPE, body: JSON.stringify({ error: { code: "MODULE_NOT_CONFIGURED", message: `${module} is not configured on this gateway` } }) };
}

/**
 * Gateway routes run in-process through app.inject (the gateway's own API key is added here, server side, and
 * never reaches the browser). pitube is an upstream service, reached over HTTP with its own token.
 */
export function createUiForward(app: FastifyInstance, config: AppConfig): UiForward {
  return async (rule: UiRouteRule, request: { method: UiMethod; url: string; body: unknown }): Promise<ForwardedResponse> => {
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (rule.module === "pitube") {
      if (!config.pitubeApiUrl) return notConfigured("pitube");
      const headers: Record<string, string> = { accept: "application/json" };
      if (payload !== undefined) headers["content-type"] = "application/json";
      if (config.pitubeApiToken) headers.authorization = `Bearer ${config.pitubeApiToken}`;
      try {
        // The base URL's origin is used; a path in PIGATEWAY_PITUBE_API_URL is not kept.
        const res = await fetch(new URL(request.url, config.pitubeApiUrl), {
          method: request.method,
          headers,
          signal: AbortSignal.timeout(5000),
          ...(payload !== undefined ? { body: payload } : {})
        });
        return { statusCode: res.status, contentType: res.headers.get("content-type") ?? JSON_TYPE, body: await res.text() };
      } catch {
        return { statusCode: 502, contentType: JSON_TYPE, body: JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "pitube did not answer" } }) };
      }
    }
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await app.inject({ method: request.method, url: request.url, headers, ...(payload !== undefined ? { payload } : {}) });
    return { statusCode: res.statusCode, contentType: String(res.headers["content-type"] ?? JSON_TYPE), body: res.body };
  };
}

/** The picontrol UI listeners that are switched on by config (none unless PIGATEWAY_UI_PORT or _RELAY_PORT is set). */
export function createUiListeners(app: FastifyInstance, config: AppConfig): UiListenerSpec[] {
  if (config.uiPort === undefined && config.uiRelayPort === undefined) return [];
  const pinAuth = config.uiPin ? createPinAuth({ pin: config.uiPin }) : undefined;
  // The relay's page is on another site (the Pi's own domain), so its cookie is SameSite=None; Secure.
  const relayAuth = config.uiPin ? createPinAuth({ pin: config.uiPin, sameSite: "None", secure: true }) : createOpenAuth();
  const forward = createUiForward(app, config);
  // The relay always needs the PIN; the LAN listener needs it unless PIGATEWAY_UI_LAN_NO_PIN=true.
  const lanAuth = config.uiLanNoPin || !pinAuth ? createOpenAuth() : pinAuth;
  const specs: UiListenerSpec[] = [];
  if (config.uiPort !== undefined) {
    specs.push({ role: "lan", host: "0.0.0.0", port: config.uiPort, app: buildUiListener({ role: "lan", auth: lanAuth, forward, corsOrigins: config.uiCorsOrigins, logger: app.log }) });
  }
  if (config.uiRelayPort !== undefined) {
    // Local only: the ssh tunnel from the relay is the way in.
    specs.push({ role: "relay", host: "127.0.0.1", port: config.uiRelayPort, app: buildUiListener({ role: "relay", auth: relayAuth, forward, corsOrigins: config.uiCorsOrigins, logger: app.log }) });
  }
  // No hooks here: this is called after the main app may already be listening, and Fastify refuses addHook then.
  // The caller closes the listeners (see main.ts).
  return specs;
}
