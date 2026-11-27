import type { FastifyBaseLogger } from "fastify";

export interface PiTimerClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiTimerClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiTimerClientOptions) {
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
    timeoutMs = 15000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiTimer is not configured"), { statusCode: 503, code: "PITIMER_NOT_CONFIGURED" });
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
      res = await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiTimer upstream request failed");
      throw Object.assign(new Error("PiTimer upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : res.statusText || `HTTP ${res.status}`;
      const msgStr = typeof message === "string" ? message : message?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msgStr), { statusCode: res.status, code: "UPSTREAM_ERROR" });
    }

    return payload as T;
  }

  async getStatus(): Promise<unknown> {
    return this.request("GET", "/api/v1/timers/status");
  }

  async setMute(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/timers/mute", body);
  }

  async unmute(): Promise<unknown> {
    return this.request("POST", "/api/v1/timers/unmute");
  }

  async listTimers(): Promise<unknown> {
    return this.request("GET", "/api/v1/timers");
  }

  async createTimer(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/timers", body);
  }

  async parseScript(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/timers/parse", body);
  }

  async getTimer(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/timers/${encodeURIComponent(id)}`);
  }

  async updateTimer(id: string, body: unknown): Promise<unknown> {
    return this.request("PUT", `/api/v1/timers/${encodeURIComponent(id)}`, body);
  }

  async deleteTimer(id: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/timers/${encodeURIComponent(id)}`);
  }

  async muteTimer(id: string, body?: unknown): Promise<unknown> {
    return this.request("POST", `/api/v1/timers/${encodeURIComponent(id)}/mute`, body || {});
  }

  async unmuteTimer(id: string): Promise<unknown> {
    return this.request("POST", `/api/v1/timers/${encodeURIComponent(id)}/unmute`);
  }

  async runPhase(id: string, phase?: string): Promise<unknown> {
    return this.request("POST", `/api/v1/timers/${encodeURIComponent(id)}/run`, phase ? { phase } : {});
  }

  async cancelRun(runId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/timers/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async listRuns(limit?: number): Promise<unknown> {
    return this.request("GET", `/api/v1/timers/runs${limit ? `?limit=${limit}` : ""}`);
  }
}
