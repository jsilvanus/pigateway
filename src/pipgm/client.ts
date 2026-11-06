import type { FastifyBaseLogger } from "fastify";

export interface PiProgramClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiProgramClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiProgramClientOptions) {
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
      throw Object.assign(new Error("PiProgram is not configured"), { statusCode: 503, code: "PIPGM_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}`, "x-api-key": this.#token } : {}),
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
      this.#logger?.warn({ err, url, method }, "PiProgram upstream request failed");
      throw Object.assign(new Error("PiProgram upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiProgram returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiProgram returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getPipelines() {
    return this.request("GET", "/api/v1/pipgm/pipelines");
  }

  getPipeline(pipelineId: string) {
    return this.request("GET", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}`);
  }

  setPipeline(pipelineId: string, body: unknown) {
    return this.request("PUT", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}`, body);
  }

  cuePipeline(pipelineId: string, body: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/cue`, body);
  }

  stepPipeline(pipelineId: string, body?: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/step`, body);
  }

  playPipeline(pipelineId: string, body?: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/play`, body);
  }

  pausePipeline(pipelineId: string, body?: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/pause`, body);
  }

  audioPipeline(pipelineId: string, body: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/audio`, body);
  }

  audioStopPipeline(pipelineId: string) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/audio/stop`);
  }

  killAudio() {
    return this.request("POST", "/api/v1/pipgm/audio/kill");
  }

  setPlaylist(pipelineId: string, body: unknown) {
    return this.request("PUT", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/playlist`, body);
  }

  addToPlaylist(pipelineId: string, body: unknown) {
    return this.request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/playlist`, body);
  }

  removeFromPlaylist(pipelineId: string, itemId: string) {
    return this.request("DELETE", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/playlist/${encodeURIComponent(itemId)}`);
  }

  listItems() {
    return this.request("GET", "/api/v1/pipgm/items");
  }

  getItem(itemId: string) {
    return this.request("GET", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}`);
  }

  deleteItem(itemId: string) {
    return this.request("DELETE", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}`);
  }

  createCanvaItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/canva", body);
  }

  setUseAt(itemId: string, body: unknown) {
    return this.request("PUT", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/use-at`, body);
  }

  packageItem(itemId: string, orientation?: string, body?: unknown) {
    const q = orientation ? `?orientation=${encodeURIComponent(orientation)}` : "";
    return this.request("POST", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/package${q}`, body);
  }

  getTask(taskId: string) {
    return this.request("GET", `/api/v1/pipgm/tasks/${encodeURIComponent(taskId)}`);
  }

  getItemSteps(itemId: string, orientation?: string) {
    const q = orientation ? `?orientation=${encodeURIComponent(orientation)}` : "";
    return this.request("GET", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/steps${q}`);
  }

  prepareItem(itemId: string, body: unknown) {
    return this.request("POST", `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/prepare`, body);
  }

  getFeeders() {
    return this.request("GET", "/api/v1/pipgm/feeders");
  }

  getLibraryStorage() {
    return this.request("GET", "/api/v1/pipgm/library/storage");
  }
}
