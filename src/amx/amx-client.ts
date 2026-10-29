import { Socket } from "node:net";
import type { FastifyBaseLogger } from "fastify";

export interface AmxRouteRequest {
  input: number; // 1-4 Atlona input
  output: number; // 1-5 Atlona output (1 Proj1, 2 Proj2, 3 Screen3, 4 Screen4, 5 Videomixer)
}

export interface AmxRouteResponse {
  requestId: string;
  success: boolean;
  input: number;
  output: number;
  confirmed: boolean;
  message?: string | undefined;
}

export type AmxClientStatus = "connected" | "unavailable" | "not-configured" | "simulated";

export interface AmxClient {
  routeMatrix(input: number, output: number, timeoutMs?: number): Promise<AmxRouteResponse>;
  getStatus(): Promise<AmxClientStatus>;
  /** Atlona output (1-5) -> input (null = unknown), read from AMX; null when AMX cannot answer. */
  atlonaRoutes(timeoutMs?: number): Promise<Record<number, number | null> | null>;
  epsonCommand(target: "proj1" | "proj2", action: "RAW" | "POWER" | "SOURCE", value: string, timeoutMs?: number): Promise<{ success: boolean; message: string }>;
  epsonStatus(target: "proj1" | "proj2", timeoutMs?: number): Promise<{ status: number; source: string } | null>;
  close(): Promise<void>;
}

export class SimulatedAmxClient implements AmxClient {
  private readonly logger?: FastifyBaseLogger | undefined;
  private reqCount = 0;

  constructor(logger?: FastifyBaseLogger | undefined) {
    this.logger = logger;
  }

  async routeMatrix(input: number, output: number): Promise<AmxRouteResponse> {
    this.reqCount += 1;
    const requestId = `sim-${this.reqCount}`;
    this.logger?.info({ requestId, input, output }, "Simulated AMX Atlona route request");
    return {
      requestId,
      success: true,
      input,
      output,
      confirmed: true,
      message: "Simulated Atlona route confirmed"
    };
  }

  async getStatus(): Promise<AmxClientStatus> {
    return "simulated";
  }

  async atlonaRoutes(): Promise<null> {
    return null;
  }

  async epsonCommand(target: "proj1" | "proj2", action: "RAW" | "POWER" | "SOURCE", value: string): Promise<{ success: boolean; message: string }> {
    return { success: true, message: `Simulated ${target} ${action} ${value}` };
  }

  async epsonStatus(target: "proj1" | "proj2"): Promise<{ status: number; source: string } | null> {
    return { status: 1, source: "80" };
  }

  async close(): Promise<void> {
    // No-op
  }
}

export class DisabledAmxClient implements AmxClient {
  async routeMatrix(input: number, output: number): Promise<AmxRouteResponse> {
    return {
      requestId: "none",
      success: false,
      input,
      output,
      confirmed: false,
      message: "AMX client is not configured"
    };
  }

  async getStatus(): Promise<AmxClientStatus> {
    return "not-configured";
  }

  async atlonaRoutes(): Promise<null> {
    return null;
  }

  async epsonCommand(): Promise<{ success: boolean; message: string }> {
    return { success: false, message: "AMX client is not configured" };
  }

  async epsonStatus(): Promise<null> {
    return null;
  }

  async close(): Promise<void> {
    // No-op
  }
}

export class TcpAmxClient implements AmxClient {
  private readonly host: string;
  private readonly port: number;
  private readonly logger?: FastifyBaseLogger | undefined;
  private socket: Socket | null = null;
  private reqCount = 0;
  private buffer = "";
  private statusRequests = new Map<
    string,
    { resolve: (routes: Record<number, number | null>) => void; timer: NodeJS.Timeout }
  >();
  private epsonRequests = new Map<
    string,
    { resolve: (res: any) => void; timer: NodeJS.Timeout }
  >();
  private pendingRequests = new Map<
    string,
    {
      resolve: (res: AmxRouteResponse) => void;
      reject: (err: Error) => void;
      input: number;
      output: number;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(host: string, port: number, logger?: FastifyBaseLogger | undefined) {
    this.host = host;
    this.port = port;
    this.logger = logger;
  }

  private async getConnectedSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.setEncoding("utf8");

      socket.connect(this.port, this.host, () => {
        this.socket = socket;
        this.logger?.info({ host: this.host, port: this.port }, "Connected to AMX NetLinx master");
        resolve(socket);
      });

      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        this.processIncoming();
      });

      socket.on("error", (err) => {
        this.logger?.warn({ err }, "AMX NetLinx TCP client error");
        reject(err);
      });

      socket.on("close", () => {
        this.socket = null;
        for (const [id, req] of this.pendingRequests.entries()) {
          clearTimeout(req.timer);
          req.reject(new Error("Connection closed before response"));
          this.pendingRequests.delete(id);
        }
      });
    });
  }

  private processIncoming(): void {
    while (this.buffer.includes(";")) {
      const index = this.buffer.indexOf(";");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);

      if (!line) continue;

      const parts = line.split(":").map((p) => p.trim());
      if (parts[0] === "EPSON") {
        const reqId = parts[1];
        if (reqId && this.epsonRequests.has(reqId)) {
          const req = this.epsonRequests.get(reqId)!;
          clearTimeout(req.timer);
          this.epsonRequests.delete(reqId);
          if (parts[3] === "STATUS") {
            req.resolve({ status: Number(parts[4] ?? 0), source: parts[5] ?? "" });
          } else {
            req.resolve({ success: parts[3] === "OK", message: line });
          }
          continue;
        }
      }
      // e.g. ATLONA:CONFIRMED:<reqId>:<in>:<out> or <reqId>:ATLONA:CONFIRMED:<in>:<out>
      let reqId: string | null = null;
      let status = "";

      if (parts[0] === "ATLONA") {
        status = parts[1] ?? "";
        reqId = parts[2] ?? null;
      } else if (parts[1] === "ATLONA") {
        reqId = parts[0] ?? null;
        status = parts[2] ?? "";
      }

      if (status === "STATUS" && reqId && this.statusRequests.has(reqId)) {
        const req = this.statusRequests.get(reqId)!;
        clearTimeout(req.timer);
        this.statusRequests.delete(reqId);
        const routes: Record<number, number | null> = {};
        (parts[3] ?? "").split(",").forEach((value, index) => {
          const input = Number(value);
          routes[index + 1] = Number.isInteger(input) && input >= 1 && input <= 4 ? input : null;
        });
        req.resolve(routes);
        continue;
      }

      if (reqId && this.pendingRequests.has(reqId)) {
        const req = this.pendingRequests.get(reqId)!;
        clearTimeout(req.timer);
        this.pendingRequests.delete(reqId);

        if (status === "CONFIRMED" || status === "OK" || status === "ACK") {
          req.resolve({
            requestId: reqId,
            success: true,
            input: req.input,
            output: req.output,
            confirmed: status === "CONFIRMED" || status === "OK",
            message: `ATLONA ${status}`
          });
        } else {
          req.resolve({
            requestId: reqId,
            success: false,
            input: req.input,
            output: req.output,
            confirmed: false,
            message: line
          });
        }
      }
    }
  }

  async routeMatrix(input: number, output: number, timeoutMs = 3000): Promise<AmxRouteResponse> {
    this.reqCount += 1;
    const requestId = `req-${Date.now()}-${this.reqCount}`;
    const socket = await this.getConnectedSocket();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout waiting for AMX response for request ${requestId}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        input,
        output,
        timer
      });

      const wireCommand = `ATLONA:ROUTE:${requestId}:${input}:${output};\r\n`;
      socket.write(wireCommand);
    });
  }

  /** ATLONA:STATUS:<reqId>; -> ATLONA:STATUS:<reqId>:<o1>,...,<o5>; (0 = unknown). */
  async atlonaRoutes(timeoutMs = 1500): Promise<Record<number, number | null> | null> {
    try {
      const socket = await this.getConnectedSocket();
      this.reqCount += 1;
      const requestId = `st-${Date.now()}-${this.reqCount}`;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.statusRequests.delete(requestId);
          resolve(null);
        }, timeoutMs);
        this.statusRequests.set(requestId, { resolve, timer });
        socket.write(`ATLONA:STATUS:${requestId};\r\n`);
      });
    } catch {
      return null;
    }
  }

  async epsonCommand(
    target: "proj1" | "proj2",
    action: "RAW" | "POWER" | "SOURCE",
    value: string,
    timeoutMs = 3000
  ): Promise<{ success: boolean; message: string }> {
    const socket = await this.getConnectedSocket();
    this.reqCount += 1;
    const requestId = `ep-${Date.now()}-${this.reqCount}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.epsonRequests.delete(requestId);
        resolve({ success: false, message: `Timeout waiting for Epson response (${requestId})` });
      }, timeoutMs);
      this.epsonRequests.set(requestId, { resolve, timer });
      socket.write(`EPSON:${requestId}:${target}:${action}:${value};\r\n`);
    });
  }

  async epsonStatus(target: "proj1" | "proj2", timeoutMs = 2000): Promise<{ status: number; source: string } | null> {
    try {
      const socket = await this.getConnectedSocket();
      this.reqCount += 1;
      const requestId = `eps-${Date.now()}-${this.reqCount}`;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.epsonRequests.delete(requestId);
          resolve(null);
        }, timeoutMs);
        this.epsonRequests.set(requestId, { resolve, timer });
        socket.write(`EPSON:${requestId}:${target}:STATUS;\r\n`);
      });
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<AmxClientStatus> {
    if (this.socket && !this.socket.destroyed) {
      return "connected";
    }
    try {
      const sock = await this.getConnectedSocket();
      return sock && !sock.destroyed ? "connected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [id, req] of this.statusRequests.entries()) {
      clearTimeout(req.timer);
      req.resolve({});
      this.statusRequests.delete(id);
    }
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error("AMX client closed"));
      this.pendingRequests.delete(id);
    }
  }
}

export function createAmxClient(
  simulated: boolean,
  host?: string | undefined,
  port = 6500,
  logger?: FastifyBaseLogger | undefined
): AmxClient {
  if (host) {
    return new TcpAmxClient(host, port, logger);
  }
  if (simulated) {
    return new SimulatedAmxClient(logger);
  }
  return new DisabledAmxClient();
}
