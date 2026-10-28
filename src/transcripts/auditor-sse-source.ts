import type { FastifyBaseLogger } from "fastify";
import type { TranscriptHub } from "./transcript-hub.js";

export interface AuditorSseSourceOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  hub: TranscriptHub;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
  /** Dead-connection timeout; the Auditor sends a heartbeat every 15 s. */
  idleTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Pull delivery: follows one live Auditor session's SSE stream and feeds its transcripts to the hub.
 * The gateway only starts it for a session that PiVoice has just opened.
 */
export class AuditorSseSource {
  readonly #options: AuditorSseSourceOptions;
  readonly #fetch: typeof fetch;
  #session: string | null = null;
  #abort: AbortController | null = null;
  #stats = { connected: false, reconnects: 0, lastError: null as string | null, lastEventAt: null as string | null };

  constructor(options: AuditorSseSourceOptions) {
    this.#options = options;
    this.#fetch = options.fetchFn ?? fetch;
  }

  configured(): boolean {
    return Boolean(this.#options.baseUrl);
  }

  status() {
    return { configured: this.configured(), session: this.#session, ...this.#stats };
  }

  start(sessionId: string): void {
    if (!this.configured()) return;
    if (this.#session === sessionId) return;
    this.stop();
    this.#session = sessionId;
    const abort = new AbortController();
    this.#abort = abort;
    void this.#run(sessionId, abort.signal);
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#session = null;
    this.#stats.connected = false;
  }

  async #run(session: string, signal: AbortSignal): Promise<void> {
    const base = (this.#options.baseUrl as string).replace(/\/+$/, "");
    const minBackoff = this.#options.minBackoffMs ?? 250;
    const maxBackoff = this.#options.maxBackoffMs ?? 5000;
    const idleMs = this.#options.idleTimeoutMs ?? 45_000;
    let backoff = minBackoff;
    let lastEventId: string | null = null;
    while (!signal.aborted) {
      const connection = new AbortController();
      const abortConnection = () => connection.abort();
      signal.addEventListener("abort", abortConnection, { once: true });
      let idleTimer: NodeJS.Timeout | undefined;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => connection.abort(), idleMs);
        idleTimer.unref?.();
      };
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;
        if (lastEventId !== null) headers["last-event-id"] = lastEventId;
        armIdle();
        const response = await this.#fetch(`${base}/v1/live/${encodeURIComponent(session)}/events`, { headers, signal: connection.signal });
        if (response.status === 404 || response.status === 410) {
          // The session is gone; nothing to follow any more.
          this.#stats.lastError = `session ended (HTTP ${response.status})`;
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Auditor events failed (HTTP ${response.status})`);
        this.#stats.connected = true;
        this.#stats.lastError = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let eventName = "message";
        let eventId: string | null = null;
        let data: string[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
          pending += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            if (line === "") {
              if (data.length > 0 && eventName === "transcript") {
                try {
                  this.#options.hub.ingest(session, [JSON.parse(data.join("\n"))]);
                  this.#stats.lastEventAt = new Date().toISOString();
                  backoff = minBackoff;
                } catch {
                  this.#stats.lastError = "unparseable transcript event";
                }
              }
              if (eventId !== null) lastEventId = eventId;
              eventName = "message";
              eventId = null;
              data = [];
            } else if (line.startsWith("id:")) eventId = line.slice(3).trim();
            else if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
        }
        if (!signal.aborted) throw new Error("Auditor event stream ended");
      } catch (error) {
        if (signal.aborted) return;
        this.#stats.lastError = error instanceof Error ? error.message : String(error);
        this.#options.logger?.warn({ err: error }, "Auditor transcript stream interrupted");
      } finally {
        clearTimeout(idleTimer);
        signal.removeEventListener("abort", abortConnection);
        this.#stats.connected = false;
      }
      if (signal.aborted) return;
      this.#stats.reconnects++;
      const wait = backoff + Math.random() * backoff * 0.25;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      backoff = Math.min(maxBackoff, backoff * 2);
    }
  }
}
