import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AmxClient } from "./amx-client.js";
import type { GatewayEventBroker } from "../events.js";

export interface MatrixState {
  locked: boolean;
  routes: Record<number, number | null>;
}

/**
 * Atlona matrix state as the AMX master reports it, and the route/lock endpoints.
 * AMX stays the only controller of the Atlona; this only asks it.
 */
export class AtlonaMatrix {
  readonly state: MatrixState = { locked: false, routes: { 1: null, 2: null, 3: null, 4: null, 5: null } };
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly client: AmxClient,
    private readonly events: GatewayEventBroker,
    private readonly logger?: FastifyBaseLogger | undefined
  ) {}

  startPolling(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const routes = await this.client.atlonaRoutes();
      if (!routes) return;
      if (!Object.entries(routes).some(([out, input]) => this.state.routes[Number(out)] !== input)) return;
      Object.assign(this.state.routes, routes);
      this.emit();
    } catch (err) {
      this.logger?.warn({ err }, "Atlona poll failed");
    } finally {
      this.polling = false;
    }
  }

  emit(lastChange?: { input: number; output: number }): void {
    this.events.emit({
      type: "matrix",
      data: { locked: this.state.locked, routes: { ...this.state.routes }, ...(lastChange ? { lastChange } : {}) }
    });
  }

  async route(input: number, output: number, mode = "simulation"): Promise<{ success: boolean; message?: string | undefined }> {
    const status = await this.client.getStatus();
    const result =
      mode === "simulation" && status === "not-configured"
        ? { requestId: `sim-${Date.now()}`, success: true, input, output, confirmed: true, message: "Simulated Atlona route confirmed" }
        : await this.client.routeMatrix(input, output);
    if (result.success) {
      this.state.routes[output] = input;
      this.emit({ input, output });
    }
    return result;
  }

  register(app: FastifyInstance, mode: string): void {
    app.get("/api/v1/matrix", async () => this.state);

    app.put<{ Body: { locked?: unknown } }>("/api/v1/matrix/lock", async (request, reply) => {
      if (typeof request.body?.locked !== "boolean") {
        return reply.code(422).send({ error: { code: "INVALID_LOCK_STATE", message: "locked must be a boolean" } });
      }
      this.state.locked = request.body.locked;
      this.emit();
      return reply.code(200).send(this.state);
    });

    app.post<{ Body: { input?: unknown; output?: unknown } }>("/api/v1/matrix/route", async (request, reply) => {
      const input = Number(request.body?.input);
      const output = Number(request.body?.output);
      if (!Number.isInteger(input) || input < 1 || input > 4) {
        return reply.code(422).send({ error: { code: "INVALID_INPUT", message: "Matrix input must be an integer between 1 and 4" } });
      }
      if (!Number.isInteger(output) || output < 1 || output > 5) {
        return reply.code(422).send({ error: { code: "INVALID_OUTPUT", message: "Matrix output must be an integer between 1 and 5" } });
      }
      try {
        const status = await this.client.getStatus();
        const result =
          mode === "simulation" && status === "not-configured"
            ? { requestId: `sim-${Date.now()}`, success: true, input, output, confirmed: true, message: "Simulated Atlona route confirmed" }
            : await this.client.routeMatrix(input, output);
        if (!result.success) {
          return reply.code(502).send({ error: { code: "AMX_ROUTE_FAILED", message: result.message ?? "AMX request was not accepted" } });
        }
        this.state.routes[output] = input;
        this.emit({ input, output });
        return reply.code(200).send(result);
      } catch (err) {
        return reply.code(502).send({ error: { code: "AMX_UNAVAILABLE", message: err instanceof Error ? err.message : "AMX request failed" } });
      }
    });
  }
}
