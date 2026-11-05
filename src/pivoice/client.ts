import type { FastifyBaseLogger } from "fastify";

export interface PiVoiceClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiVoiceClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiVoiceClientOptions) {
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
    timeoutMs = 5000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiVoice is not configured"), { statusCode: 503, code: "VOICE_NOT_CONFIGURED" });
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
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      res = await this.#fetch(url, init);
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiVoice upstream request failed");
      throw Object.assign(new Error("PiVoice upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : `PiVoice returned HTTP ${res.status}`;
      const msgStr = typeof message === "object" && message && "message" in message ? message.message : String(message);
      throw Object.assign(new Error(msgStr || `PiVoice returned HTTP ${res.status}`), { statusCode: res.status, payload });
    }

    return payload as T;
  }

  getStatus() {
    return this.request("GET", "/api/v1/status");
  }

  getConfig() {
    return this.request("GET", "/api/v1/config");
  }

  updateConfig(patch: unknown) {
    return this.request("PUT", "/api/v1/config", patch);
  }

  startCapture() {
    return this.request("POST", "/api/v1/capture/start");
  }

  stopCapture() {
    return this.request("POST", "/api/v1/capture/stop");
  }

  getRadio() {
    return this.request("GET", "/api/v1/radio");
  }

  async setRadioTargetMode(targetId: string, mode: string) {
    const cfg = (await this.getConfig()) as { radio?: { targets?: Array<{ id: string; mode: string }> } };
    const currentTargets = Array.isArray(cfg?.radio?.targets) ? cfg.radio.targets : [];
    const exists = currentTargets.some((t) => t.id === targetId);
    const targets = exists
      ? currentTargets.map((t) => (t.id === targetId ? { ...t, mode } : t))
      : [...currentTargets, { id: targetId, mode }];
    return this.updateConfig({ radio: { targets } });
  }

  getCaptionsStatus() {
    return this.request("GET", "/api/v1/captions/status");
  }

  getAudioDevices() {
    return this.request("GET", "/api/v1/audio/devices");
  }

  getAudioMixer(card?: string) {
    return this.request("GET", `/api/v1/audio/mixer${card ? `?card=${encodeURIComponent(card)}` : ""}`);
  }

  setAudioMixer(body: unknown, card?: string) {
    return this.request("PUT", `/api/v1/audio/mixer${card ? `?card=${encodeURIComponent(card)}` : ""}`, body);
  }
}
