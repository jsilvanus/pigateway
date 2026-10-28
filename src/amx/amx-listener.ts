import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { FastifyBaseLogger } from "fastify";

/** What the gateway itself answers for the AMX commands CAM and STATUS:ALL. */
export interface AmxControl {
  cameras(): Array<{ id: string; connection: string; power: "on" | "standby" | "unknown" }>;
  cameraPower(id: string, on: boolean): Promise<void>;
  cameraPreset(id: string, presetId: number, save: boolean): Promise<void>;
  cameraMove(id: string, direction: string): Promise<void>;
  cameraZoom(id: string, action: string): Promise<void>;
  /** Atlona output 1..5 -> input (null = unknown). */
  atlonaRoutes(): Record<number, number | null>;
  atemState?(): {
    connected: boolean;
    programInput: number | null;
    previewInput: number | null;
    fadeToBlack?: { isFullyBlack: boolean; inTransition: boolean };
    downstreamKeyers?: Array<{ dsk: number; onAir: boolean; tie: boolean }>;
  } | undefined;
  encoderState?(): {
    connected: boolean;
    encoder1?: { state: string };
    encoder2?: { state: string };
  } | undefined;
  atemPreview?(input: number): Promise<void>;
  atemCut?(): Promise<void>;
  atemAuto?(): Promise<void>;
  atemFtb?(): Promise<void>;
  atemDskTie?(dsk: number, tie: boolean): Promise<void>;
  atemDskOnAir?(dsk: number, onAir: boolean): Promise<void>;
  encoderAction?(target: 1 | 2 | "both", action: "start" | "stop"): Promise<void>;
}

/** Sends one raw protocol line (without the `;`) to the video service and returns its reply, or null if it cannot answer. */
export type VideoForward = (line: string) => Promise<string | null>;

export interface AmxListenerOptions {
  control: AmxControl;
  /** pimatrix: owns SOURCE, OUTPUT, QUICK and PROGRAM. Without it those commands answer ERR:VIDEO_UNAVAILABLE. */
  forward?: VideoForward | undefined;
  host: string;
  port: number;
  mode: string;
  logger?: FastifyBaseLogger | undefined;
  allowedIps?: string[] | undefined;
}

const KNOWN_COMMANDS = new Set(["DEV", "PING", "STATUS", "SOURCE", "OUTPUT", "CAM", "QUICK", "PROGRAM", "ATEM", "ENCODER", "HELP"]);
const FORWARDED = new Set(["SOURCE", "OUTPUT", "QUICK", "PROGRAM"]);
const MOVE_DIRECTIONS = new Set(["up", "down", "left", "right", "upleft", "upright", "downleft", "downright", "stop", "home"]);
const ZOOM_ACTIONS = new Set(["in", "out", "stop"]);

/**
 * Talks the AMX line protocol (docs/amx-protocol.md in pimatrix): ASCII, `;` ends a message,
 * `:` separates fields, an optional leading message id is repeated in the reply.
 * Camera commands run here; video commands go to pimatrix through `forward`.
 */
export class AmxTcpListener {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private boundPort: number | null = null;

  constructor(private readonly options: AmxListenerOptions) {}

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleClient(socket));
      this.server = server;
      server.on("error", (err) => {
        this.options.logger?.error({ err }, "AMX TCP listener server error");
        reject(err);
      });
      server.listen(this.options.port, this.options.host, () => {
        const address = server.address();
        this.boundPort = address && typeof address === "object" ? address.port : this.options.port;
        this.options.logger?.info({ host: this.options.host, port: this.boundPort }, "AMX TCP listener started");
        resolve(this.boundPort);
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
      this.boundPort = null;
    }
  }

  private handleClient(socket: Socket): void {
    const rawIp = socket.remoteAddress;
    const remoteIp = rawIp ? rawIp.replace(/^::ffff:/, "") : undefined;
    const allowed = this.options.allowedIps?.map((ip) => ip.trim());
    if (allowed && allowed.length > 0) {
      const ok = remoteIp && (allowed.includes(remoteIp) || (allowed.includes("localhost") && (remoteIp === "127.0.0.1" || remoteIp === "::1")));
      if (!ok) {
        this.options.logger?.warn({ remoteAddress: rawIp }, "Rejected AMX connection from non-allowed address");
        socket.destroy();
        return;
      }
    }
    this.clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2048) {
        buffer = "";
        this.send(socket, "ERR:LINE_TOO_LONG");
        return;
      }
      while (buffer.includes(";")) {
        const index = buffer.indexOf(";");
        const rawCmd = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (rawCmd.length === 0) continue;
        try {
          const response = await this.dispatch(rawCmd);
          if (response) this.send(socket, response);
        } catch (error) {
          this.send(socket, `ERR:DISPATCH_FAILED:${error instanceof Error ? error.message : "INTERNAL_ERROR"}`);
        }
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", (err) => {
      this.options.logger?.warn({ err }, "AMX TCP client socket error");
      this.clients.delete(socket);
    });
  }

  private send(socket: Socket, payload: string): void {
    if (!socket.destroyed) socket.write(`${payload};\r\n`);
  }

  private async dispatch(raw: string): Promise<string> {
    const parts = raw.split(":").map((p) => p.trim());
    if (!parts[0]) return "ERR:EMPTY_COMMAND";

    let msgId: string | null = null;
    let cmd = parts[0].toUpperCase();
    let args = parts.slice(1);
    if (!KNOWN_COMMANDS.has(cmd) && parts.length > 1 && KNOWN_COMMANDS.has(parts[1]?.toUpperCase() ?? "")) {
      msgId = parts[0];
      cmd = (parts[1] ?? "").toUpperCase();
      args = parts.slice(2);
    }
    const wrap = (res: string): string => (msgId ? `${msgId}:${res}` : res);

    if (cmd === "DEV" && args[0]?.toUpperCase() === "VERSION") return wrap("DEV:VERSION:1");
    if (cmd === "PING") return wrap("PONG");
    if (cmd === "CAM") return wrap(await this.dispatchCamera(args));
    if (cmd === "ATEM") return wrap(await this.dispatchAtem(args));
    if (cmd === "ENCODER") return wrap(await this.dispatchEncoder(args));
    if (cmd === "STATUS" && args[0]?.toUpperCase() === "ALL") return wrap(`STATUS:ALL:${await this.statusAll()}`);
    if (cmd === "STATUS") return wrap(`STATUS:OK:mode=${this.options.mode}`);
    if (FORWARDED.has(cmd)) return wrap(await this.forwardVideo([cmd, ...args].join(":")));
    if (cmd === "HELP") {
      return wrap(
        "HELP:COMMANDS=DEV:VERSION,PING,STATUS,STATUS:ALL,SOURCE:LIST,SOURCE:GET,OUTPUT:LIST,OUTPUT:SET," +
          "CAM:LIST,CAM:<id|ALL>:POWER:ON|OFF,CAM:<id>:PRESET|SAVE:<n>,CAM:<id>:MOVE:<dir>,CAM:<id>:ZOOM:IN|OUT|STOP," +
          "QUICK:LIST,QUICK:RUN:<n>,PROGRAM:ON|OFF|STATUS"
      );
    }
    return wrap(`ERR:UNKNOWN_COMMAND:${cmd}`);
  }

  private async forwardVideo(line: string): Promise<string> {
    const forward = this.options.forward;
    if (!forward) return "ERR:VIDEO_UNAVAILABLE";
    const reply = await forward(line).catch(() => null);
    return reply ?? "ERR:VIDEO_UNAVAILABLE";
  }

  /** Video fields from pimatrix (when it answers) plus the camera and Atlona fields owned here. */
  private async statusAll(): Promise<string> {
    const fields = new Map<string, string>([["mode", this.options.mode]]);
    const video = this.options.forward ? await this.forwardVideo("STATUS:ALL") : null;
    const prefix = "STATUS:ALL:";
    if (video?.startsWith(prefix)) {
      for (const pair of video.slice(prefix.length).split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const key = pair.slice(0, eq);
        // the gateway owns these, whatever pimatrix reports
        if (/^cam\d+(pwr|link)$/.test(key) || key === "atlona") continue;
        fields.set(key, pair.slice(eq + 1));
      }
    }
    for (const cam of this.options.control.cameras()) {
      fields.set(`${cam.id}pwr`, cam.power);
      fields.set(`${cam.id}link`, cam.connection);
    }
    const routes = this.options.control.atlonaRoutes();
    fields.set("atlona", [1, 2, 3, 4, 5].map((out) => routes[out] ?? 0).join("/"));

    const atem = this.options.control.atemState?.();
    if (atem) {
      fields.set("atem_conn", atem.connected ? "1" : "0");
      if (atem.previewInput !== null && atem.previewInput !== undefined) fields.set("atem_pvw", String(atem.previewInput));
      if (atem.programInput !== null && atem.programInput !== undefined) fields.set("atem_pgm", String(atem.programInput));
      if (atem.fadeToBlack) fields.set("atem_ftb", atem.fadeToBlack.isFullyBlack ? "on" : "off");
      if (atem.downstreamKeyers) {
        for (const d of atem.downstreamKeyers) {
          fields.set(`dsk${d.dsk}_air`, d.onAir ? "on" : "off");
          fields.set(`dsk${d.dsk}_tie`, d.tie ? "on" : "off");
        }
      }
    }

    const enc = this.options.control.encoderState?.();
    if (enc) {
      fields.set("enc_conn", enc.connected ? "1" : "0");
      if (enc.encoder1) fields.set("enc1", enc.encoder1.state);
      if (enc.encoder2) fields.set("enc2", enc.encoder2.state);
    }

    return [...fields].map(([k, v]) => `${k}=${v}`).join(",");
  }

  private async dispatchAtem(args: string[]): Promise<string> {
    const sub = args[0]?.toUpperCase();
    if (sub === "PVW") {
      const input = Number(args[1]);
      if (!Number.isInteger(input) || input < 1) return "ERR:INVALID_INPUT";
      if (!this.options.control.atemPreview) return "ERR:ATEM_UNAVAILABLE";
      await this.options.control.atemPreview(input);
      return `ATEM:OK:PVW:${input}`;
    }
    if (sub === "CUT") {
      if (!this.options.control.atemCut) return "ERR:ATEM_UNAVAILABLE";
      await this.options.control.atemCut();
      return "ATEM:OK:CUT";
    }
    if (sub === "AUTO") {
      if (!this.options.control.atemAuto) return "ERR:ATEM_UNAVAILABLE";
      await this.options.control.atemAuto();
      return "ATEM:OK:AUTO";
    }
    if (sub === "FTB") {
      if (!this.options.control.atemFtb) return "ERR:ATEM_UNAVAILABLE";
      await this.options.control.atemFtb();
      return "ATEM:OK:FTB";
    }
    if (sub?.startsWith("DSK")) {
      const dskNum = Number(sub.replace("DSK", ""));
      const action = args[1]?.toUpperCase();
      const val = args[2]?.toUpperCase() === "ON";
      if (action === "TIE") {
        if (!this.options.control.atemDskTie) return "ERR:ATEM_UNAVAILABLE";
        await this.options.control.atemDskTie(dskNum, val);
        return `ATEM:OK:DSK${dskNum}:TIE:${val ? "ON" : "OFF"}`;
      }
      if (action === "ONAIR") {
        if (!this.options.control.atemDskOnAir) return "ERR:ATEM_UNAVAILABLE";
        await this.options.control.atemDskOnAir(dskNum, val);
        return `ATEM:OK:DSK${dskNum}:ONAIR:${val ? "ON" : "OFF"}`;
      }
    }
    return `ERR:UNKNOWN_ATEM_ACTION:${sub ?? "missing"}`;
  }

  private async dispatchEncoder(args: string[]): Promise<string> {
    const targetStr = args[0]?.toLowerCase();
    const actionStr = args[1]?.toLowerCase();
    if (actionStr !== "start" && actionStr !== "stop") return "ERR:INVALID_ACTION";
    let target: 1 | 2 | "both" = "both";
    if (targetStr === "enc1" || targetStr === "1") target = 1;
    else if (targetStr === "enc2" || targetStr === "2") target = 2;
    else if (targetStr === "all" || targetStr === "both") target = "both";
    else return "ERR:INVALID_TARGET";

    if (!this.options.control.encoderAction) return "ERR:ENCODER_UNAVAILABLE";
    await this.options.control.encoderAction(target, actionStr);
    return `ENCODER:OK:${targetStr.toUpperCase()}:${actionStr.toUpperCase()}`;
  }

  private async dispatchCamera(args: string[]): Promise<string> {
    const control = this.options.control;
    const first = args[0] ?? "";
    if (first.toUpperCase() === "LIST") {
      return `CAM:LIST:${control.cameras().map((c) => `${c.id}=${c.power}/${c.connection}`).join(",")}`;
    }
    const known = control.cameras().map((c) => c.id);
    const lower = first.toLowerCase();
    const wanted = lower === "all" ? "all" : /^\d+$/.test(lower) ? `cam${lower}` : lower;
    if (wanted !== "all" && !known.includes(wanted)) return `ERR:CAMERA_NOT_FOUND:${first || "missing"}`;
    const targets = wanted === "all" ? known : [wanted];
    const action = args[1]?.toUpperCase();
    const value = args[2]?.toLowerCase() ?? "";

    if (action === "POWER") {
      if (value !== "on" && value !== "off") return "ERR:INVALID_POWER";
      for (const id of targets) await control.cameraPower(id, value === "on");
      return `CAM:OK:${wanted}:POWER:${value.toUpperCase()}`;
    }
    if (wanted === "all") return "ERR:CAMERA_REQUIRED";
    const id = targets[0] as string;
    if (action === "PRESET" || action === "SAVE") {
      const preset = Number(value);
      if (!/^\d+$/.test(value) || preset > 254) return "ERR:INVALID_PRESET";
      await control.cameraPreset(id, preset, action === "SAVE");
      return `CAM:OK:${id}:${action}:${preset}`;
    }
    if (action === "MOVE") {
      if (!MOVE_DIRECTIONS.has(value)) return "ERR:INVALID_DIRECTION";
      await control.cameraMove(id, value);
      return `CAM:OK:${id}:MOVE:${value.toUpperCase()}`;
    }
    if (action === "ZOOM") {
      if (!ZOOM_ACTIONS.has(value)) return "ERR:INVALID_ZOOM";
      await control.cameraZoom(id, value);
      return `CAM:OK:${id}:ZOOM:${value.toUpperCase()}`;
    }
    return "ERR:UNKNOWN_CAMERA_ACTION";
  }
}

/** Forwards one line to a pimatrix AMX listener on its own port and returns the first reply line. */
export function tcpVideoForward(host: string, port: number, timeoutMs = 5000): VideoForward {
  return (line) =>
    new Promise((resolve) => {
      const socket: Socket = createConnection({ host, port });
      let data = "";
      let done = false;
      const finish = (value: string | null): void => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(value);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs, () => finish(null));
      socket.on("connect", () => socket.write(`${line};\r\n`));
      socket.on("data", (chunk: string) => {
        data += chunk;
        const end = data.indexOf(";");
        if (end >= 0) finish(data.slice(0, end).trim());
      });
      socket.on("error", () => finish(null));
      socket.on("close", () => finish(null));
    });
}
