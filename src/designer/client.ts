import type { FastifyBaseLogger } from "fastify";

export interface PiDesignerClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiDesignerClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiDesignerClientOptions) {
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? fetch;
    this.#logger = options.logger;
  }

  configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = 10000,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiDesigner is not configured"), { statusCode: 503, code: "DESIGNER_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(customHeaders ?? {})
    };
    if (body !== undefined && !headers["content-type"] && !(body instanceof Uint8Array) && !(body instanceof Buffer)) {
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
        init.body = (body instanceof Uint8Array || body instanceof Buffer) ? (body as any) : JSON.stringify(body);
      }
      res = await this.#fetch(url, init);
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiDesigner upstream request failed");
      throw Object.assign(new Error("PiDesigner upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiDesigner returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiDesigner returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getState() {
    return this.request("GET", "/api/v1/designer/state");
  }

  setState(body: unknown) {
    return this.request("POST", "/api/v1/designer/state", body);
  }

  addItem(body: unknown) {
    return this.request("POST", "/api/v1/designer/items", body);
  }

  updateItem(id: string, body: unknown) {
    return this.request("PUT", `/api/v1/designer/items/${encodeURIComponent(id)}`, body);
  }

  deleteItem(id: string) {
    return this.request("DELETE", `/api/v1/designer/items/${encodeURIComponent(id)}`);
  }

  setMetadata(body: unknown) {
    return this.request("PATCH", "/api/v1/designer/metadata", body);
  }

  loadTemplate(body: unknown) {
    return this.request("POST", "/api/v1/designer/template", body);
  }

  agentChat(body: unknown) {
    return this.request("POST", "/api/v1/designer/agent/chat", body);
  }

  listTemplates() {
    return this.request("GET", "/api/v1/templates");
  }

  getTemplate(id: string) {
    return this.request("GET", `/api/v1/templates/${encodeURIComponent(id)}`);
  }

  validate(body: unknown) {
    return this.request("POST", "/api/v1/validate", body);
  }

  push(body: unknown) {
    return this.request("POST", "/api/v1/push", body);
  }
}
