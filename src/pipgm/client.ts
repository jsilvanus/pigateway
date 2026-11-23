import type { FastifyBaseLogger } from "fastify";

/** Largest request body the gateway forwards for media, PPTX and Canva packages (piprogram accepts 50 MB base64). */
export const PIPGM_UPLOAD_BODY_LIMIT = 60 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface PiProgramClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string;
  /** 206 when the upstream honoured a Range request. */
  status?: number;
  contentRange?: string | undefined;
}

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const pipe = (pipelineId: string) => `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}`;
const item = (itemId: string) => `/api/v1/pipgm/items/${encodeURIComponent(itemId)}`;

/**
 * Client for piprogram 1.0 (openapi/openapi.yaml in jsilvanus/piprogram). Writes carry the API key, which only
 * the gateway holds. Paths and bodies are passed through as the spec defines them.
 */
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

  async #fetchUpstream(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    timeoutMs: number,
    customHeaders?: Record<string, string>
  ): Promise<{ res: Response; json: boolean }> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiProgram is not configured"), { statusCode: 503, code: "PIPGM_NOT_CONFIGURED" });
    }
    const headers: Record<string, string> = {
      accept: "application/json, */*",
      ...(this.#token ? { authorization: `Bearer ${this.#token}`, "x-api-key": this.#token } : {}),
      ...(customHeaders ?? {})
    };
    const isRaw = body instanceof Uint8Array || body instanceof Buffer;
    if (body !== undefined && !headers["content-type"] && !isRaw) {
      headers["content-type"] = "application/json";
    }

    const url = `${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
      if (body !== undefined) init.body = isRaw ? (body as any) : JSON.stringify(body);
      res = await this.#fetch(url, init);
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiProgram upstream request failed");
      throw Object.assign(new Error("PiProgram upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }
    return { res, json: (res.headers.get("content-type") || "").includes("application/json") };
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    const { res, json } = await this.#fetchUpstream(method, path, body, timeoutMs, customHeaders);
    const payload = json ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiProgram returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiProgram returned HTTP ${res.status}`), {
        statusCode: res.status,
        code: typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>) ? (payload as { error: { code?: string } }).error?.code : undefined,
        payload
      });
    }
    return payload as T;
  }

  /** For PNG, JPEG and other binary answers (frames, step pictures, assets). */
  async requestBinary(path: string, query?: Query, timeoutMs = DEFAULT_TIMEOUT_MS, range?: string): Promise<BinaryResponse> {
    const { res } = await this.#fetchUpstream("GET", withQuery(path, query), undefined, timeoutMs, range ? { range } : undefined);
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const message = (payload as { error?: { message?: string } }).error?.message ?? `PiProgram returned HTTP ${res.status}`;
      throw Object.assign(new Error(message), {
        statusCode: res.status,
        code: (payload as { error?: { code?: string } }).error?.code,
        payload
      });
    }
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "application/octet-stream",
      ...(res.status === 206 ? { status: 206, contentRange: res.headers.get("content-range") ?? undefined } : {})
    };
  }

  // Pipelines

  getPipelines(query?: Query) {
    return this.request("GET", withQuery("/api/v1/pipgm/pipelines", query));
  }

  getPipeline(pipelineId: string) {
    return this.request("GET", pipe(pipelineId));
  }

  getPipelineFrame(pipelineId: string, query?: Query) {
    return this.requestBinary(`${pipe(pipelineId)}/frame.png`, query);
  }

  updatePipelineConfig(pipelineId: string, body: unknown) {
    return this.request("PUT", `${pipe(pipelineId)}/config`, body);
  }

  controlPipeline(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/control`, body);
  }

  setFadeToBlack(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/ftb`, body);
  }

  setPipelineAudio(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/audio`, body);
  }

  playPipelineAudio(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/audio/play`, body);
  }

  stopPipelineAudio(pipelineId: string) {
    return this.request("POST", `${pipe(pipelineId)}/audio/stop`);
  }

  killAudio() {
    return this.request("POST", "/api/v1/pipgm/audio/kill");
  }

  setPipelineBasicImage(pipelineId: string, body: unknown) {
    return this.request("PUT", `${pipe(pipelineId)}/basic-image`, body);
  }

  addPlaylistItem(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/playlist`, body);
  }

  removePlaylistItem(pipelineId: string, itemId: string) {
    return this.request("DELETE", `${pipe(pipelineId)}/playlist/${encodeURIComponent(itemId)}`);
  }

  // Playlists: the live playlist of a feed, and saved playlists (piprogram playlist API)

  getPlaylistSteps(pipelineId: string) {
    return this.request("GET", `${pipe(pipelineId)}/playlist/steps`);
  }

  setPlaylistOrder(pipelineId: string, body: unknown) {
    return this.request("PUT", `${pipe(pipelineId)}/playlist/order`, body);
  }

  loadPlaylist(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/playlist/load`, body);
  }

  savePlaylist(pipelineId: string, body: unknown) {
    return this.request("POST", `${pipe(pipelineId)}/playlist/save`, body);
  }

  listSavedPlaylists() {
    return this.request("GET", "/api/v1/pipgm/playlists");
  }

  createSavedPlaylist(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/playlists", body);
  }

  generatePlaylist(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/playlists/generate", body);
  }

  getSavedPlaylist(playlistId: string) {
    return this.request("GET", `/api/v1/pipgm/playlists/${encodeURIComponent(playlistId)}`);
  }

  replaceSavedPlaylist(playlistId: string, body: unknown) {
    return this.request("PUT", `/api/v1/pipgm/playlists/${encodeURIComponent(playlistId)}`, body);
  }

  deleteSavedPlaylist(playlistId: string) {
    return this.request("DELETE", `/api/v1/pipgm/playlists/${encodeURIComponent(playlistId)}`);
  }

  // Legacy names (the gateway's /cue, /step, /play, /pause), translated to piprogram 1.0 control actions.

  async cuePipeline(pipelineId: string, body: { itemId?: string; stepIndex?: number } | undefined) {
    const cue = body ?? {};
    if (!cue.itemId && cue.stepIndex === undefined) {
      throw Object.assign(new Error("cue needs itemId or stepIndex"), { statusCode: 422, code: "VALIDATION_ERROR" });
    }
    let last: unknown;
    if (cue.itemId) last = await this.controlPipeline(pipelineId, { action: "gotoItem", itemId: cue.itemId });
    if (cue.stepIndex !== undefined) last = await this.controlPipeline(pipelineId, { action: "gotoStep", stepIndex: cue.stepIndex });
    return last;
  }

  stepPipeline(pipelineId: string) {
    return this.controlPipeline(pipelineId, { action: "next" });
  }

  playPipeline(pipelineId: string) {
    return this.controlPipeline(pipelineId, { action: "play" });
  }

  pausePipeline(pipelineId: string) {
    return this.controlPipeline(pipelineId, { action: "pause" });
  }

  // Feeders and text to speech

  getFeeders() {
    return this.request("GET", "/api/v1/pipgm/feeders");
  }

  prepareSpeech(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/tts/prepare", body, UPLOAD_TIMEOUT_MS);
  }

  // Library items and storage

  /** Filters (type, kind, q, usedFrom, usedTo, unscheduled, sort, limit, offset) go to piprogram as they are. */
  listItems(query?: Query) {
    return this.request("GET", withQuery("/api/v1/pipgm/items", query));
  }

  updateItem(itemId: string, body: unknown) {
    return this.request("PATCH", item(itemId), body);
  }

  getActiveFolder(query?: Query) {
    return this.request("GET", withQuery("/api/v1/pipgm/library/active", query));
  }

  addToActiveFolder(itemId: string) {
    return this.request("PUT", `/api/v1/pipgm/library/active/${encodeURIComponent(itemId)}`);
  }

  removeFromActiveFolder(itemId: string) {
    return this.request("DELETE", `/api/v1/pipgm/library/active/${encodeURIComponent(itemId)}`);
  }

  clearActiveFolder() {
    return this.request("DELETE", "/api/v1/pipgm/library/active");
  }

  createPlaylistFromActiveFolder(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/library/active/playlist", body);
  }

  getItem(itemId: string) {
    return this.request("GET", item(itemId));
  }

  deleteItem(itemId: string) {
    return this.request("DELETE", item(itemId));
  }

  getLibraryStorage() {
    return this.request("GET", "/api/v1/pipgm/library/storage");
  }

  getAsset(assetId: string, range?: string) {
    return this.requestBinary(`/api/v1/pipgm/assets/${encodeURIComponent(assetId)}`, undefined, DEFAULT_TIMEOUT_MS, range);
  }

  getHymnals() {
    return this.request("GET", "/api/v1/pipgm/hymnals");
  }

  createHymnItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/hymn", body);
  }

  createYouTubeItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/youtube", body);
  }

  createMediaItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/media", body, UPLOAD_TIMEOUT_MS);
  }

  createPptxItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/pptx", body, UPLOAD_TIMEOUT_MS);
  }

  createCanvaItem(body: unknown) {
    return this.request("POST", "/api/v1/pipgm/items/canva", body);
  }

  setItemUseAt(itemId: string, body: unknown) {
    return this.request("PUT", `${item(itemId)}/use-at`, body);
  }

  listItemSteps(itemId: string, orientation?: string | undefined) {
    return this.request("GET", withQuery(`${item(itemId)}/steps`, { orientation }));
  }

  prepareItemSteps(itemId: string, body?: unknown) {
    return this.request("POST", `${item(itemId)}/prepare`, body ?? {});
  }

  getStepImage(itemId: string, step: number, orientation?: string | undefined) {
    return this.requestBinary(`${item(itemId)}/steps/${step}/image.png`, { orientation });
  }

  getStepThumbnail(itemId: string, step: number, orientation?: string | undefined) {
    return this.requestBinary(`${item(itemId)}/steps/${step}/thumbnail.jpg`, { orientation });
  }

  /** Canva export package: a zip (application/zip) or JSON `{ pages: [...] }`. */
  uploadCanvaExportPackage(itemId: string, body: Buffer | object, options: { orientation?: string | undefined; contentType?: string | undefined } = {}) {
    const headers = options.contentType ? { "content-type": options.contentType } : undefined;
    return this.request(
      "POST",
      withQuery(`${item(itemId)}/canva/export-package`, { orientation: options.orientation }),
      body,
      UPLOAD_TIMEOUT_MS,
      headers
    );
  }

  getTask(taskId: string) {
    return this.request("GET", `/api/v1/pipgm/tasks/${encodeURIComponent(taskId)}`);
  }
}
