import type { FastifyBaseLogger } from "fastify";

export interface PiNotifyClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiNotifyClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiNotifyClientOptions) {
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
    timeoutMs = 10000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiNotify is not configured"), { statusCode: 503, code: "PINOTIFY_NOT_CONFIGURED" });
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
      this.#logger?.warn({ err, url, method }, "PiNotify upstream request failed");
      throw Object.assign(new Error("PiNotify upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
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

  async send(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/notify", body);
  }

  async getContacts(): Promise<unknown> {
    return this.request("GET", "/api/v1/contacts");
  }

  async getContact(slug: string): Promise<unknown> {
    return this.request("GET", `/api/v1/contacts/${encodeURIComponent(slug)}`);
  }

  async createContact(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/contacts", body);
  }

  async updateContact(slug: string, body: unknown): Promise<unknown> {
    return this.request("PUT", `/api/v1/contacts/${encodeURIComponent(slug)}`, body);
  }

  async deleteContact(slug: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/contacts/${encodeURIComponent(slug)}`);
  }

  async getProvider(): Promise<unknown> {
    return this.request("GET", "/api/v1/provider");
  }

  async updateProvider(body: unknown): Promise<unknown> {
    return this.request("PUT", "/api/v1/provider", body);
  }

  async deleteProvider(): Promise<unknown> {
    return this.request("DELETE", "/api/v1/provider");
  }

  async getLog(limit?: number): Promise<unknown> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request("GET", `/api/v1/log${qs}`);
  }

  async getOutbox(): Promise<unknown> {
    return this.request("GET", "/api/v1/outbox");
  }
}
