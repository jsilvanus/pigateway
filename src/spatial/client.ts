import type { FastifyBaseLogger } from "fastify";

export interface PiSpaceClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiSpaceClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiSpaceClientOptions) {
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
      throw Object.assign(new Error("PiSpace is not configured"), { statusCode: 503, code: "PISPACE_NOT_CONFIGURED" });
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
      this.#logger?.warn({ err, url, method }, "PiSpace upstream request failed");
      throw Object.assign(new Error("PiSpace upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
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

  async getVenue(): Promise<unknown> {
    return this.request("GET", "/api/v1/venue");
  }

  async getZones(): Promise<unknown> {
    return this.request("GET", "/api/v1/zones");
  }

  async getZone(zoneId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/zones/${encodeURIComponent(zoneId)}`);
  }

  async getOccluders(): Promise<unknown> {
    return this.request("GET", "/api/v1/occluders");
  }

  async getOccluder(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/occluders/${encodeURIComponent(id)}`);
  }

  async solvePtz(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/solve-ptz", body);
  }

  async project(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/project", body);
  }

  async triangulate(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/triangulate", body);
  }
}
