import dgram from "node:dgram";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayEventBroker, ScreenTrackingPayload, ScreenTrackingObject } from "../events.js";

export const TRACKING_MAGIC = 0x5054; // ASCII "PT" (Pi Tracking)
export const TRACKING_VERSION = 1;
export const TRACKING_TYPE_SNAPSHOT = 0x01;
export const TRACKING_STALE_MS = 5000;

export interface FeedScreenTracking {
  cameraId: string;
  sequence: number;
  timestampMs: number;
  lastSeenAtMs: number;
  lastSeenAtIso: string;
  stale: boolean;
  objects: ScreenTrackingObject[];
}

export interface ScreenTrackingUdpReceiverOptions {
  host: string;
  port: number;
  allowedIps?: string[] | undefined;
  staleMs?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
  eventBroker?: GatewayEventBroker | undefined;
  now?: (() => number) | undefined;
}

export function decodeTrackingPacket(buf: Buffer): ScreenTrackingPayload | null {
  if (buf.length < 2) return null;

  // JSON fallback if starts with '{' (0x7B)
  if (buf[0] === 0x7b) {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.cameraId) return null;
      const objects: ScreenTrackingObject[] = Array.isArray(parsed.objects)
        ? parsed.objects.map((o: any) => {
            let bbox: [number, number, number, number] = [0, 0, 0, 0];
            if (Array.isArray(o.bbox) && o.bbox.length === 4) {
              bbox = [Number(o.bbox[0]), Number(o.bbox[1]), Number(o.bbox[2]), Number(o.bbox[3])];
            } else if (o.bbox && typeof o.bbox === "object") {
              const ymin = Number(o.bbox.y ?? 0);
              const xmin = Number(o.bbox.x ?? 0);
              const ymax = ymin + Number(o.bbox.h ?? 0);
              const xmax = xmin + Number(o.bbox.w ?? 0);
              bbox = [ymin, xmin, ymax, xmax];
            }
            const [ymin, xmin, ymax, xmax] = bbox;
            return {
              trackId: Number(o.trackId ?? 0),
              confidence: Number(o.confidence ?? 100),
              classId: Number(o.classId ?? 0),
              bbox,
              rect: {
                x: xmin,
                y: ymin,
                w: Math.max(0, xmax - xmin),
                h: Math.max(0, ymax - ymin),
              },
              velocity: o.velocity,
              label: o.label ?? "person",
            };
          })
        : [];

      return {
        sequence: typeof parsed.sequence === "number" ? parsed.sequence : 0,
        timestampMs: typeof parsed.timestampMs === "number" ? parsed.timestampMs : Date.now(),
        cameraId: String(parsed.cameraId),
        objects,
      };
    } catch {
      return null;
    }
  }

  // Binary wire format
  if (buf.length < 20) return null;

  let offset = 0;
  const magic = buf.readUInt16BE(offset);
  offset += 2;
  if (magic !== TRACKING_MAGIC) return null;

  const version = buf.readUInt8(offset);
  offset += 1;
  if (version !== TRACKING_VERSION) return null;

  const type = buf.readUInt8(offset);
  offset += 1;
  if (type !== TRACKING_TYPE_SNAPSHOT) return null;

  offset += 2; // skip reserved flags

  const sequence = buf.readUInt32BE(offset);
  offset += 4;
  const timestampMs = Number(buf.readBigUInt64BE(offset));
  offset += 8;

  const camIdLen = buf.readUInt8(offset);
  offset += 1;
  if (offset + camIdLen > buf.length) return null;

  const cameraId = buf.toString("utf8", offset, offset + camIdLen);
  offset += camIdLen;

  if (offset >= buf.length) return null;
  const objectCount = buf.readUInt8(offset);
  offset += 1;

  if (offset + objectCount * 18 > buf.length) return null;

  const objects: ScreenTrackingObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const trackId = buf.readUInt16BE(offset);
    offset += 2;
    const confidence = buf.readUInt8(offset);
    offset += 1;
    const classId = buf.readUInt8(offset);
    offset += 1;

    const ymin = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const xmin = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const ymax = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const xmax = buf.readUInt16BE(offset) / 65535;
    offset += 2;

    const vx = buf.readInt16BE(offset) / 10000;
    offset += 2;
    const vy = buf.readInt16BE(offset) / 10000;
    offset += 2;

    offset += 2; // skip reserved

    const normalizedBbox: [number, number, number, number] = [
      Math.round(ymin * 1e4) / 1e4,
      Math.round(xmin * 1e4) / 1e4,
      Math.round(ymax * 1e4) / 1e4,
      Math.round(xmax * 1e4) / 1e4,
    ];

    objects.push({
      trackId,
      confidence,
      classId,
      label: classId === 0 ? "person" : "object",
      bbox: normalizedBbox,
      rect: {
        x: normalizedBbox[1],
        y: normalizedBbox[0],
        w: Math.max(0, Math.round((normalizedBbox[3] - normalizedBbox[1]) * 1e4) / 1e4),
        h: Math.max(0, Math.round((normalizedBbox[2] - normalizedBbox[0]) * 1e4) / 1e4),
      },
      velocity: { vx, vy },
    });
  }

  return {
    sequence,
    timestampMs,
    cameraId,
    objects,
  };
}

export class ScreenTrackingUdpReceiver {
  readonly #options: ScreenTrackingUdpReceiverOptions;
  readonly #now: () => number;
  readonly #staleMs: number;
  readonly #allowedIps: Set<string> | null;
  #socket: dgram.Socket | null = null;
  #listening = false;
  #boundPort = 0;
  #packetCount = 0;
  #feeds = new Map<string, FeedScreenTracking>();
  #lastPayloadByCamera = new Map<string, Buffer>();

  constructor(options: ScreenTrackingUdpReceiverOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#staleMs = options.staleMs ?? TRACKING_STALE_MS;
    this.#allowedIps = options.allowedIps?.length
      ? new Set(options.allowedIps.map((ip) => ip.replace(/^::ffff:/, "")))
      : null;
    this.#boundPort = options.port;
  }

  getBoundPort(): number {
    return this.#boundPort;
  }

  isListening(): boolean {
    return this.#listening;
  }

  getState(): {
    listening: boolean;
    port: number;
    packetCount: number;
    feeds: Record<string, FeedScreenTracking>;
  } {
    const now = this.#now();
    const feedsRecord: Record<string, FeedScreenTracking> = {};

    for (const [id, feed] of this.#feeds.entries()) {
      const isStale = now - feed.lastSeenAtMs >= this.#staleMs;
      feedsRecord[id] = {
        ...feed,
        stale: isStale,
      };
    }

    return {
      listening: this.#listening,
      port: this.#boundPort,
      packetCount: this.#packetCount,
      feeds: feedsRecord,
    };
  }

  start(): Promise<void> {
    if (this.#socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      this.#socket = socket;

      socket.on("error", (err) => {
        this.#options.logger?.error({ err, port: this.#options.port }, "Screen tracking UDP error");
        if (!this.#listening) {
          reject(err);
        }
      });

      socket.on("message", (buf, remote) => {
        const remoteIp = remote.address.replace(/^::ffff:/, "");
        if (this.#allowedIps && !this.#allowedIps.has(remoteIp)) {
          return;
        }

        const nowMs = this.#now();

        // 1. Binary early drop: drop identical status snapshots early to save decoding,
        // allocations, SSE fanout, and coordinator evaluations.
        if (buf.length >= 20 && buf.readUInt16BE(0) === TRACKING_MAGIC) {
          const camIdLen = buf.readUInt8(18);
          if (19 + camIdLen <= buf.length) {
            const cameraId = buf.toString("utf8", 19, 19 + camIdLen);
            const payload = buf.subarray(18); // semantic content: cameraId, count, and all objects
            const lastPayload = this.#lastPayloadByCamera.get(cameraId);
            const existingFeed = this.#feeds.get(cameraId);

            if (existingFeed && !existingFeed.stale && lastPayload && payload.equals(lastPayload)) {
              this.#packetCount++;
              existingFeed.lastSeenAtMs = nowMs;
              existingFeed.sequence = buf.readUInt32BE(6);
              existingFeed.timestampMs = Number(buf.readBigUInt64BE(10));
              return;
            }
          }
        }

        const decoded = decodeTrackingPacket(buf);
        if (!decoded) return;

        // 2. JSON fallback early drop
        if (buf[0] === 0x7b) {
          const payloadKey = Buffer.from(JSON.stringify(decoded.objects));
          const lastPayload = this.#lastPayloadByCamera.get(decoded.cameraId);
          const existingFeed = this.#feeds.get(decoded.cameraId);

          if (existingFeed && !existingFeed.stale && lastPayload && payloadKey.equals(lastPayload)) {
            this.#packetCount++;
            existingFeed.lastSeenAtMs = nowMs;
            existingFeed.sequence = decoded.sequence;
            existingFeed.timestampMs = decoded.timestampMs;
            return;
          }
          this.#lastPayloadByCamera.set(decoded.cameraId, payloadKey);
        } else if (buf.length >= 20) {
          this.#lastPayloadByCamera.set(decoded.cameraId, Buffer.from(buf.subarray(18)));
        }

        this.#packetCount++;
        const nowIso = new Date(nowMs).toISOString();

        const feedState: FeedScreenTracking = {
          cameraId: decoded.cameraId,
          sequence: decoded.sequence,
          timestampMs: decoded.timestampMs,
          lastSeenAtMs: nowMs,
          lastSeenAtIso: nowIso,
          stale: false,
          objects: decoded.objects,
        };

        this.#feeds.set(decoded.cameraId, feedState);

        // Emit onto gateway event broker
        if (this.#options.eventBroker) {
          this.#options.eventBroker.emit({
            type: "screen-tracking",
            data: decoded,
          });

          // Also emit to perception for backward compatibility
          this.#options.eventBroker.emit({
            type: "perception",
            data: {
              cameraId: decoded.cameraId,
              timestamp: nowIso,
              objects: decoded.objects.map((o) => ({
                trackId: o.trackId,
                bbox: o.rect,
                label: o.label,
                confidence: o.confidence / 100,
                velocity: o.velocity,
              })),
            },
          });
        }
      });

      socket.bind(this.#options.port, this.#options.host, () => {
        this.#listening = true;
        const addr = socket.address();
        this.#boundPort = typeof addr === "object" ? addr.port : this.#options.port;
        this.#options.logger?.info(
          { host: this.#options.host, port: this.#boundPort },
          "Screen tracking UDP receiver listening"
        );
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.#socket) return Promise.resolve();

    return new Promise((resolve) => {
      this.#socket?.close(() => {
        this.#socket = null;
        this.#listening = false;
        resolve();
      });
    });
  }
}
