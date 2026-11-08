import type { FastifyBaseLogger } from "fastify";

export interface PiMatrixClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiMatrixClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiMatrixClientOptions) {
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
    timeoutMs = 5000,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiMatrix is not configured"), { statusCode: 503, code: "MATRIX_NOT_CONFIGURED" });
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
      this.#logger?.warn({ err, url, method }, "PiMatrix upstream request failed");
      throw Object.assign(new Error("PiMatrix upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("image/")) {
      return (Buffer.from(await res.arrayBuffer())) as unknown as T;
    }

    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiMatrix returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiMatrix returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getSources() {
    return this.request("GET", "/api/v1/sources");
  }

  getSource(id: string) {
    return this.request("GET", `/api/v1/sources/${encodeURIComponent(id)}`);
  }

  getOutputs() {
    return this.request("GET", "/api/v1/outputs");
  }

  setOutputSource(outputId: string, data: unknown) {
    return this.request("POST", `/api/v1/outputs/${encodeURIComponent(outputId)}/source`, data);
  }

  getMultiviewLayout() {
    return this.request("GET", "/api/v1/outputs/multiview");
  }

  setMultiviewLayout(data: unknown) {
    return this.request("POST", "/api/v1/outputs/multiview/layout", data);
  }

  setMultiviewSlot(data: unknown) {
    return this.request("POST", "/api/v1/outputs/multiview/slot", data);
  }

  setRtspSource(data: unknown) {
    return this.request("POST", "/api/v1/outputs/rtsp/source", data);
  }

  setRtspStream(data: unknown) {
    return this.request("POST", "/api/v1/outputs/rtsp/stream", data);
  }

  setCrop(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/crop`, data);
  }

  setCropPreset(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/crop/preset`, data);
  }

  moveCrop(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/crop/move`, data);
  }

  resizeCrop(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/crop/resize`, data);
  }

  setFtb(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/ftb`, data);
  }

  setMute(sourceId: string, data: unknown) {
    return this.request("POST", `/api/v1/sources/${encodeURIComponent(sourceId)}/effects/mute`, data);
  }

  getComposites() {
    return this.request("GET", "/api/v1/composites");
  }

  getComposite(id: string) {
    return this.request("GET", `/api/v1/composites/${encodeURIComponent(id)}`);
  }

  async getCompositePreview(id: string): Promise<Buffer> {
    return this.request<Buffer>("GET", `/api/v1/composites/${encodeURIComponent(id)}/preview.png`);
  }

  setSlide(imageBytes: Uint8Array | Buffer, contentType = "image/png") {
    return this.request("PUT", "/api/v1/composites/slide", imageBytes, 10000, { "content-type": contentType });
  }

  startComposite(id: string) {
    return this.request("POST", `/api/v1/composites/${encodeURIComponent(id)}/start`);
  }

  stopComposite(id: string) {
    return this.request("POST", `/api/v1/composites/${encodeURIComponent(id)}/stop`);
  }

  getQuickOptions() {
    return this.request("GET", "/api/v1/quick-options");
  }

  applyQuickOption(id: string) {
    return this.request("POST", `/api/v1/quick-options/${encodeURIComponent(id)}/apply`);
  }

  applyQuickOptionNumber(number: number) {
    return this.request("POST", `/api/v1/quick-options/number/${encodeURIComponent(number)}/apply`);
  }
}
