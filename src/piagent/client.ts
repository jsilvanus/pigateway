import type { FastifyBaseLogger } from "fastify";

export interface PiAgentClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger | undefined;
}

export class PiAgentClient {
  readonly #baseUrl?: string | undefined;
  readonly #token?: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger?: FastifyBaseLogger | undefined;

  constructor(options: PiAgentClientOptions) {
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
    timeoutMs = 15000
  ): Promise<T> {
    if (!this.#baseUrl) {
      throw Object.assign(new Error("PiAgent is not configured"), { statusCode: 503, code: "PIAGENT_NOT_CONFIGURED" });
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
      res = await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (err) {
      this.#logger?.warn({ err, url, method }, "PiAgent upstream request failed");
      throw Object.assign(new Error("PiAgent upstream unavailable"), { statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const message =
        typeof payload === "object" && payload && "error" in (payload as Record<string, unknown>)
          ? (payload as { error?: { message?: string } | string }).error
          : res.statusText || `HTTP ${res.status}`;
      const msgStr = typeof message === "string" ? message : message?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msgStr), { statusCode: res.status, code: "UPSTREAM_ERROR" });
    }

    return payload as T;
  }

  async getAgents(): Promise<unknown> {
    return this.request("GET", "/api/v1/agents");
  }

  async createAgent(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/agents", body);
  }

  async getAgent(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/agents/${encodeURIComponent(id)}`);
  }

  async deleteAgent(id: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/agents/${encodeURIComponent(id)}`);
  }

  async stopAgent(id: string, body?: unknown): Promise<unknown> {
    return this.request("POST", `/api/v1/agents/${encodeURIComponent(id)}/stop`, body ?? {});
  }

  async interruptAgent(body?: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/agent/interrupt", body ?? {});
  }

  async chat(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/chat", body);
  }

  async sendMessage(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/messages", body);
  }

  async getInbox(agentId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/messages/inbox/${encodeURIComponent(agentId)}`);
  }

  async ackMessage(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/messages/ack", body);
  }

  async broadcastMessage(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/messages/broadcast", body);
  }

  async getModels(): Promise<unknown> {
    return this.request("GET", "/api/v1/models");
  }
}
