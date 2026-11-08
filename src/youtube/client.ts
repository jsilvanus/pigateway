import type { FastifyBaseLogger } from "fastify";

export interface PiTubeClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiTubeClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiTubeClientOptions) {
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
      throw Object.assign(new Error("PiTube is not configured"), { statusCode: 503, code: "TUBE_NOT_CONFIGURED" });
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
      this.#logger?.warn({ err, url, method }, "PiTube upstream request failed");
      throw Object.assign(new Error("PiTube upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiTube returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiTube returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getStatus() {
    return this.request("GET", "/api/v1/status");
  }

  listBroadcasts() {
    return this.request("GET", "/api/v1/broadcasts");
  }

  getCurrentBroadcast() {
    return this.request("GET", "/api/v1/broadcasts/current");
  }

  selectBroadcast(broadcastId: string) {
    return this.request("POST", "/api/v1/broadcasts/select", { broadcastId });
  }

  createBroadcast(data: unknown) {
    return this.request("POST", "/api/v1/broadcasts/create", data);
  }

  startBroadcast(to?: string) {
    return this.request("POST", "/api/v1/broadcasts/start", to ? { to } : undefined);
  }

  stopRequest() {
    return this.request("POST", "/api/v1/broadcasts/stop/request");
  }

  stopBroadcast(confirmToken?: string) {
    return this.request("POST", "/api/v1/broadcasts/stop", confirmToken ? { confirmToken } : undefined);
  }

  updateBroadcast(id: string, changes: unknown) {
    return this.request("PATCH", `/api/v1/broadcasts/${encodeURIComponent(id)}`, changes);
  }

  setPrivacy(privacy: string, broadcastId?: string) {
    return this.request("POST", "/api/v1/broadcasts/privacy", { privacy, broadcastId });
  }

  getUrls(broadcastId?: string) {
    const q = broadcastId ? `?broadcastId=${encodeURIComponent(broadcastId)}` : "";
    return this.request("GET", `/api/v1/broadcasts/url${q}`);
  }

  setThumbnail(imageBytes: Uint8Array | Buffer, contentType: string, broadcastId?: string) {
    const q = broadcastId ? `?broadcastId=${encodeURIComponent(broadcastId)}` : "";
    return this.request("POST", `/api/v1/broadcasts/thumbnail${q}`, imageBytes, 15000, { "content-type": contentType });
  }

  listStreams() {
    return this.request("GET", "/api/v1/streams");
  }

  createStream(title: string) {
    return this.request("POST", "/api/v1/streams/create", { title });
  }

  applyIngestToEncoder(target: unknown) {
    return this.request("POST", "/api/v1/ingest/apply", target);
  }

  getAuthHealth() {
    return this.request("GET", "/api/v1/auth/health");
  }

  checkAuth() {
    return this.request("POST", "/api/v1/auth/check");
  }
}
