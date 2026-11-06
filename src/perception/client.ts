import type { FastifyBaseLogger } from "fastify";

export interface PiPerceptionClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiPerceptionClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiPerceptionClientOptions) {
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? fetch;
    this.#logger = options.logger;
  }

  configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 10000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiPerception is not configured"), { statusCode: 503, code: "PIPERCEPTION_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}`, "x-api-key": this.#token } : {})
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
      this.#logger?.warn({ err, url, method }, "PiPerception upstream request failed");
      throw Object.assign(new Error("PiPerception upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
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

  async getStreams(): Promise<unknown> {
    return this.request("GET", "/api/v1/streams");
  }

  async addStream(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/streams", body);
  }

  async startStream(cameraId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/streams/${encodeURIComponent(cameraId)}/start`);
  }

  async stopStream(cameraId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/streams/${encodeURIComponent(cameraId)}/stop`);
  }

  async setStreamPath(cameraId: string, body: unknown): Promise<unknown> {
    return this.request("POST", `/api/v1/streams/${encodeURIComponent(cameraId)}/path`, body);
  }

  async getTracks(): Promise<unknown> {
    return this.request("GET", "/api/v1/tracks");
  }

  async getPusherStats(): Promise<unknown> {
    return this.request("GET", "/api/v1/pusher");
  }
}
