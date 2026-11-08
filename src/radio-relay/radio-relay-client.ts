import type { FastifyBaseLogger } from "fastify";

export class RadioRelayClient {
  private readonly baseUrl?: string | undefined;
  private readonly token?: string | undefined;
  readonly streamName: string;
  readonly mountPoint: string;
  readonly publicUrl?: string | undefined;
  private readonly logger: FastifyBaseLogger;
  constructor({ baseUrl, token, streamName, mountPoint, publicUrl, logger }: { baseUrl?: string | undefined; token?: string | undefined; streamName: string; mountPoint?: string | undefined; publicUrl?: string | undefined; logger: FastifyBaseLogger }) {
    this.baseUrl = baseUrl?.replace(/\/+$/, "");
    this.token = token;
    this.streamName = streamName;
    this.mountPoint = mountPoint ?? (streamName.startsWith("/") ? streamName : `/${streamName}`);
    this.publicUrl = publicUrl;
    this.logger = logger;
  }
  configured() { return Boolean(this.baseUrl && this.token); }
  async request(action: "start" | "stop" | "lifecycle", method: "GET" | "POST" = "GET"): Promise<unknown> {
    if (!this.configured()) throw Object.assign(new Error("Radio relay is not configured"), { statusCode: 503 });
    const response = await fetch(`${this.baseUrl}/api/v1/streams/${encodeURIComponent(this.streamName)}/${action}`, {
      method, headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw Object.assign(new Error(`Radio relay returned HTTP ${response.status}`), { statusCode: 502 });
    return response.json();
  }
  lifecycle() { return this.request("lifecycle"); }
  start() { return this.request("start", "POST"); }
  stop() { return this.request("stop", "POST"); }
  async safeLifecycle() {
    if (!this.configured()) return { configured: false, reachable: false, streamName: this.streamName, mountPoint: this.mountPoint, publicUrl: this.publicUrl ?? null };
    try {
      const state = await this.lifecycle();
      return {
        configured: true,
        reachable: true,
        streamName: this.streamName,
        mountPoint: this.mountPoint,
        publicUrl: this.publicUrl ?? null,
        state: typeof state === "object" && state !== null ? {
          mountPoint: this.mountPoint,
          streamUrl: this.publicUrl ?? (state as Record<string, unknown>)?.streamUrl,
          ...(state as Record<string, unknown>),
        } : state
      };
    }
    catch (error: unknown) {
      this.logger.warn({ err: error }, "Radio relay status request failed");
      return {
        configured: true,
        reachable: false,
        streamName: this.streamName,
        mountPoint: this.mountPoint,
        publicUrl: this.publicUrl ?? null,
        error: "Radio relay is unreachable or rejected the request"
      };
    }
  }
}
