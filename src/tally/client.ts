import type { FastifyBaseLogger } from "fastify";

export interface PiTallyClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiTallyClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiTallyClientOptions) {
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? fetch;
    this.#logger = options.logger;
  }

  configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = 5000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiTally is not configured"), { statusCode: 503, code: "TALLY_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {})
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const url = `${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      res = await this.#fetch(url, init);
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiTally upstream request failed");
      throw Object.assign(new Error("PiTally upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiTally returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiTally returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getStatus() {
    return this.request("GET", "/api/v1/status");
  }

  listLights() {
    return this.request("GET", "/api/v1/lights");
  }

  createLight(data: unknown) {
    return this.request("POST", "/api/v1/lights", data);
  }

  getLight(id: string) {
    return this.request("GET", `/api/v1/lights/${encodeURIComponent(id)}`);
  }

  deleteLight(id: string) {
    return this.request("DELETE", `/api/v1/lights/${encodeURIComponent(id)}`);
  }

  setLightState(id: string, data: unknown) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/state`, data);
  }

  sendLightCue(id: string, data: unknown) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/cue`, data);
  }

  sendLightCall(id: string) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/call`);
  }

  setLightHold(id: string, data: unknown) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/hold`, data);
  }

  setLightBrightness(id: string, data: unknown) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/brightness`, data);
  }

  cycleLight(id: string) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/cycle`);
  }

  setLightSegments(id: string, data: unknown) {
    return this.request("POST", `/api/v1/lights/${encodeURIComponent(id)}/segments`, data);
  }
}
