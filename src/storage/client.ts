import type { FastifyBaseLogger } from "fastify";

export interface PiStorageClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiStorageClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiStorageClientOptions) {
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? fetch;
    this.#logger = options.logger;
  }

  configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
    path: string,
    body?: unknown,
    timeoutMs = 15000,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiStorage is not configured"), { statusCode: 503, code: "PISTORAGE_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}`, "x-api-key": this.#token } : {}),
      ...(customHeaders ?? {})
    };
    if (body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }

    const url = `${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
      });
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiStorage upstream request failed");
      throw Object.assign(new Error("PiStorage upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    if (method === "HEAD") {
      return Object.fromEntries(res.headers.entries()) as T;
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
    return this.request("GET", "/api/v1/status");
  }

  async listObjects(prefix?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (prefix) params.set("prefix", prefix);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return this.request("GET", `/api/v1/objects${qs ? `?${qs}` : ""}`);
  }

  async getObject(key: string): Promise<unknown> {
    return this.request("GET", `/api/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  async putObject(key: string, body: unknown, contentType?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    return this.request("PUT", `/api/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`, body, 30000, headers);
  }

  async deleteObject(key: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  async createSignedUrl(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/signed-urls", body);
  }

  async setUseAt(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/use-at", body);
  }

  async flushSpool(): Promise<unknown> {
    return this.request("POST", "/api/v1/spool/flush");
  }

  async pruneCache(): Promise<unknown> {
    return this.request("POST", "/api/v1/cache/prune");
  }
}
