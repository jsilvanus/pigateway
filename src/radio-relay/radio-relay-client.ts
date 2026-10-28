import type { FastifyBaseLogger } from "fastify";

export class RadioRelayClient {
  private readonly baseUrl?: string;
  private readonly token?: string;
  readonly streamName: string;
  private readonly logger: FastifyBaseLogger;
  constructor({ baseUrl, token, streamName, logger }: { baseUrl?: string; token?: string; streamName: string; logger: FastifyBaseLogger }) {
    this.baseUrl = baseUrl?.replace(/\/+$/, "");
    this.token = token;
    this.streamName = streamName;
    this.logger = logger;
  }
  configured() { return Boolean(this.baseUrl && this.token); }
  async request(action, method = "GET") {
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
    if (!this.configured()) return { configured: false, reachable: false, streamName: this.streamName };
    try { return { configured: true, reachable: true, streamName: this.streamName, state: await this.lifecycle() }; }
    catch (error) { this.logger.warn({ err: error }, "Radio relay status request failed"); return { configured: true, reachable: false, streamName: this.streamName, error: "Radio relay is unreachable or rejected the request" }; }
  }
}
