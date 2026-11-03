import { randomUUID } from "node:crypto";

/**
 * The Canva push adapter. The Canva plugin sends the URLs of its exported pages; this service
 * downloads them, hands them to piprogram as an export package and follows piprogram's task, so the
 * plugin sees one task id with progress through download, unpacking, thumbnails and "ready".
 * Pi Program keeps the pictures; the gateway keeps only the task and the presentation records.
 */

export type CanvaTaskState = "queued" | "downloading" | "unpacking" | "preparing" | "ready" | "failed";

export interface CanvaPushPage {
  pageNumber: number;
  url: string;
  name?: string | undefined;
}

export interface CanvaTask {
  taskId: string;
  presentationId: string;
  itemId: string | null;
  title: string;
  state: CanvaTaskState;
  /** 0 to 1 over the whole job: downloading is the first 30 %, piprogram's work the rest. */
  progress: number;
  pageCount: number;
  downloaded: { done: number; total: number };
  pictures: { done: number; total: number };
  /** Kept in piprogram's library store. */
  saved: boolean;
  /** Can be put on air. */
  ready: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanvaServiceOptions {
  piprogramUrl: string;
  piprogramApiKey?: string | undefined;
  /** Host suffixes the page URLs may point to (https only). */
  downloadHosts?: string[] | undefined;
  fetchFn?: typeof fetch;
  maxPages?: number;
  maxPageBytes?: number;
  maxTotalBytes?: number;
  pollMs?: number;
  /** Give up on piprogram's task after this long. */
  taskTimeoutMs?: number;
  keepTasks?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void } | undefined;
}

const DEFAULT_HOSTS = ["canva.com", "canva.dev", "canva-apps.com"];
const DOWNLOAD_SHARE = 0.3;

export class CanvaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CanvaError";
  }
}

export function pipelineIdFor(plugin: string): string | null {
  const match = /^pipgm([1-3])$/i.exec(plugin);
  return match ? `PiPGM${match[1]}` : null;
}

export function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export class CanvaService {
  readonly #tasks = new Map<string, CanvaTask>();
  readonly #presentations = new Map<string, { itemId: string; taskId: string }>();
  readonly #opts: Required<Omit<CanvaServiceOptions, "piprogramApiKey" | "logger" | "downloadHosts">> &
    Pick<CanvaServiceOptions, "piprogramApiKey" | "logger"> & { downloadHosts: string[] };

  constructor(options: CanvaServiceOptions) {
    this.#opts = {
      piprogramUrl: options.piprogramUrl.replace(/\/+$/, ""),
      piprogramApiKey: options.piprogramApiKey,
      downloadHosts: (options.downloadHosts?.length ? options.downloadHosts : DEFAULT_HOSTS).map((h) => h.toLowerCase()),
      fetchFn: options.fetchFn ?? fetch,
      maxPages: options.maxPages ?? 200,
      maxPageBytes: options.maxPageBytes ?? 40 * 1024 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 200 * 1024 * 1024,
      pollMs: options.pollMs ?? 500,
      taskTimeoutMs: options.taskTimeoutMs ?? 10 * 60_000,
      keepTasks: options.keepTasks ?? 50,
      logger: options.logger
    };
  }

  getTask(taskId: string): CanvaTask | undefined {
    return this.#tasks.get(taskId);
  }

  getPresentation(presentationId: string): { itemId: string; task: CanvaTask } | undefined {
    const record = this.#presentations.get(presentationId);
    const task = record && this.#tasks.get(record.taskId);
    return record && task ? { itemId: record.itemId, task } : undefined;
  }

  /** Validates the request and starts the job. Resolves with the new task; the work goes on in the background. */
  start(input: { title?: unknown; pages?: unknown; orientation?: unknown; useAt?: unknown }): { task: CanvaTask; done: Promise<void> } {
    const pages = this.#validatePages(input.pages);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : "Canva presentation";
    const orientation = this.#orientation(input.orientation);
    const useAt = this.#useAt(input.useAt);
    const now = new Date().toISOString();
    const task: CanvaTask = {
      taskId: `ctask_${randomUUID().slice(0, 12)}`,
      presentationId: `pres_${randomUUID().slice(0, 8)}`,
      itemId: null,
      title,
      state: "queued",
      progress: 0,
      pageCount: pages.length,
      downloaded: { done: 0, total: pages.length },
      pictures: { done: 0, total: 0 },
      saved: false,
      ready: false,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    this.#tasks.set(task.taskId, task);
    this.#trim();
    const done = this.#run(task, pages, orientation, useAt).catch((error: unknown) => {
      this.#update(task, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      this.#opts.logger?.warn({ taskId: task.taskId, err: task.error }, "canva push failed");
    });
    return { task, done };
  }

  async #run(task: CanvaTask, pages: CanvaPushPage[], orientation: string, useAt: string[]): Promise<void> {
    const item = await this.#pg<{ id: string }>("POST", "/api/v1/pipgm/items/canva", {
      designId: `push-${task.presentationId.replace(/^pres_/, "")}`,
      title: task.title,
      pageCount: pages.length,
      ...(useAt.length ? { useAt } : {})
    });
    this.#update(task, { itemId: item.id });
    this.#presentations.set(task.presentationId, { itemId: item.id, taskId: task.taskId });

    this.#update(task, { state: "downloading" });
    const files: Array<{ pageNumber: number; filename: string; mimeType: string; dataBase64: string }> = [];
    let total = 0;
    for (const page of pages) {
      const got = await this.#download(page.url, this.#opts.maxTotalBytes - total);
      total += got.data.length;
      files.push({
        pageNumber: page.pageNumber,
        filename: `page-${page.pageNumber}.${got.extension}`,
        mimeType: got.mimeType,
        dataBase64: got.data.toString("base64")
      });
      const done = files.length;
      this.#update(task, { downloaded: { done, total: pages.length }, progress: (done / pages.length) * DOWNLOAD_SHARE });
    }

    const accepted = await this.#pg<{ taskId: string }>(
      "POST",
      `/api/v1/pipgm/items/${encodeURIComponent(item.id)}/canva/export-package?orientation=${orientation}`,
      { pages: files }
    );
    files.length = 0;
    this.#update(task, { state: "unpacking" });

    const deadline = Date.now() + this.#opts.taskTimeoutMs;
    for (;;) {
      const remote = await this.#pg<{
        state: string;
        progress: number;
        pictures?: { done: number; total: number };
        saved?: boolean;
        ready?: boolean;
        error?: string | null;
      }>("GET", `/api/v1/pipgm/tasks/${encodeURIComponent(accepted.taskId)}`);
      this.#update(task, {
        state: (remote.state === "queued" ? "unpacking" : remote.state) as CanvaTaskState,
        progress: DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * Math.max(0, Math.min(1, remote.progress ?? 0)),
        pictures: remote.pictures ?? task.pictures,
        saved: Boolean(remote.saved),
        ready: Boolean(remote.ready)
      });
      if (remote.state === "failed") throw new Error(remote.error || "piprogram could not prepare the pages");
      if (remote.state === "ready") {
        this.#update(task, { progress: 1, ready: true });
        return;
      }
      if (Date.now() > deadline) throw new Error("piprogram took too long to prepare the pages");
      await new Promise((resolve) => setTimeout(resolve, this.#opts.pollMs));
    }
  }

  #validatePages(raw: unknown): CanvaPushPage[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new CanvaError(422, "INVALID_PAGES", "pages must be a non-empty array of {pageNumber, url}");
    if (raw.length > this.#opts.maxPages) throw new CanvaError(422, "TOO_MANY_PAGES", `at most ${this.#opts.maxPages} pages`);
    const pages = raw.map((entry, index) => {
      const page = (entry ?? {}) as Record<string, unknown>;
      const pageNumber = Number.isInteger(page.pageNumber) && (page.pageNumber as number) > 0 ? (page.pageNumber as number) : index + 1;
      const url = typeof page.url === "string" ? page.url : "";
      this.#checkUrl(url);
      return { pageNumber, url, name: typeof page.name === "string" ? page.name : undefined };
    });
    const numbers = new Set(pages.map((p) => p.pageNumber));
    if (numbers.size !== pages.length) throw new CanvaError(422, "DUPLICATE_PAGE_NUMBER", "pageNumber must be unique");
    return pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  /** Service date: one entry or a list in the shared useAt format (day, hour, moment or range). piprogram checks the syntax. */
  #useAt(raw: unknown): string[] {
    if (raw === undefined || raw === null || raw === "") return [];
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > 32 || !list.every((e) => typeof e === "string" && e.trim() && e.length <= 100)) {
      throw new CanvaError(422, "INVALID_USE_AT", "useAt must be a string or a list of up to 32 strings such as 2026-11-08 or 2026-11-08T10/2026-11-08T12");
    }
    return list.map((e: string) => e.trim());
  }

  #orientation(raw: unknown): string {
    if (raw === undefined) return "landscape,portrait";
    const list = String(raw).split(",").map((o) => o.trim());
    if (!list.length || !list.every((o) => o === "landscape" || o === "portrait")) {
      throw new CanvaError(422, "INVALID_ORIENTATION", "orientation must be landscape, portrait or both separated by a comma");
    }
    return list.join(",");
  }

  #checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CanvaError(422, "INVALID_PAGE_URL", `not a URL: ${raw.slice(0, 80)}`);
    }
    if (url.protocol !== "https:" || url.username || url.password || !hostAllowed(url.hostname, this.#opts.downloadHosts)) {
      throw new CanvaError(422, "PAGE_URL_NOT_ALLOWED", `page URLs must be https on ${this.#opts.downloadHosts.join(", ")}`);
    }
    return url;
  }

  async #download(raw: string, budget: number): Promise<{ data: Buffer; mimeType: string; extension: string }> {
    let url = this.#checkUrl(raw);
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await this.#opts.fetchFn(url, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = this.#checkUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`Canva page download failed (HTTP ${res.status})`);
      const limit = Math.min(this.#opts.maxPageBytes, budget);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > limit) throw new Error("a Canva page is larger than the limit");
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Canva page download had no body");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Error("a Canva page is larger than the limit");
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks);
      const sniffed = sniffImage(data);
      if (!sniffed) throw new Error("a Canva page is not a PNG, JPEG or WebP image");
      return { data, ...sniffed };
    }
    throw new Error("too many redirects fetching a Canva page");
  }

  /** Calls piprogram; used by the push job and by the setup and control routes. */
  async #pg<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return this.pg<T>(method, path, body);
  }

  async pg<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#opts.piprogramApiKey) headers.authorization = `Bearer ${this.#opts.piprogramApiKey}`;
    let res: Response;
    try {
      res = await this.#opts.fetchFn(`${this.#opts.piprogramUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new CanvaError(502, "PIPROGRAM_UNREACHABLE", `Pi Program is not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const message = (json as { error?: { message?: string } } | null)?.error?.message ?? `Pi Program answered HTTP ${res.status}`;
      throw new CanvaError(res.status === 404 ? 404 : 502, "PIPROGRAM_ERROR", message);
    }
    return json as T;
  }

  #update(task: CanvaTask, patch: Partial<CanvaTask>): void {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  }

  #trim(): void {
    while (this.#tasks.size > this.#opts.keepTasks) {
      const oldest = this.#tasks.keys().next().value as string;
      this.#tasks.delete(oldest);
      for (const [id, rec] of this.#presentations) if (rec.taskId === oldest) this.#presentations.delete(id);
    }
  }
}

function sniffImage(data: Buffer): { mimeType: string; extension: string } | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", extension: "png" };
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg" };
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  return null;
}
