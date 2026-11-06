import type { FastifyBaseLogger } from "fastify";

export interface PiGraphicsClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiGraphicsClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiGraphicsClientOptions) {
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
      throw Object.assign(new Error("PiGraphics is not configured"), { statusCode: 503, code: "GRAPHICS_NOT_CONFIGURED" });
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
      this.#logger?.warn({ err, url, method }, "PiGraphics upstream request failed");
      throw Object.assign(new Error("PiGraphics upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiGraphics returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiGraphics returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getActive() {
    return this.request("GET", "/api/v1/graphics/active");
  }

  showGraphic(body: unknown) {
    return this.request("POST", "/api/v1/graphics/active/show", body);
  }

  hideGraphic(instanceId: string) {
    return this.request("POST", `/api/v1/graphics/active/hide/${encodeURIComponent(instanceId)}`);
  }

  clearGraphics() {
    return this.request("POST", "/api/v1/graphics/active/clear");
  }

  getBindings() {
    return this.request("GET", "/api/v1/graphics/bindings");
  }

  setBindings(body: unknown) {
    return this.request("POST", "/api/v1/graphics/bindings", body);
  }

  listTemplates() {
    return this.request("GET", "/api/v1/graphics/templates");
  }

  getTemplate(id: string) {
    return this.request("GET", `/api/v1/graphics/templates/${encodeURIComponent(id)}`);
  }

  saveTemplate(body: unknown) {
    return this.request("POST", "/api/v1/graphics/templates", body);
  }

  deleteTemplate(id: string) {
    return this.request("DELETE", `/api/v1/graphics/templates/${encodeURIComponent(id)}`);
  }

  listAssets() {
    return this.request("GET", "/api/v1/graphics/assets");
  }

  getAsset(id: string) {
    return this.request("GET", `/api/v1/graphics/assets/${encodeURIComponent(id)}`);
  }

  uploadAsset(body: unknown) {
    return this.request("POST", "/api/v1/graphics/assets", body);
  }

  deleteAsset(id: string) {
    return this.request("DELETE", `/api/v1/graphics/assets/${encodeURIComponent(id)}`);
  }

  canvaPush(body: unknown) {
    return this.request("POST", "/api/v1/graphics/canva/push", body);
  }

  canvaOffAir(body: unknown) {
    return this.request("POST", "/api/v1/graphics/canva/off-air", body);
  }

  getStreamStatus() {
    return this.request("GET", "/api/v1/graphics/stream/status");
  }

  startStream(body: unknown) {
    return this.request("POST", "/api/v1/graphics/stream/start", body);
  }

  stopStream() {
    return this.request("POST", "/api/v1/graphics/stream/stop");
  }
}
