import type { HDXStatus, InputStatus } from "@jsilvanus/matrox-monarch-control";
import type { MonarchDevice } from "../encoder/encoder-service.js";

type Enc = HDXStatus["encoder1"];

/** In-memory Monarch HDX for PIGATEWAY_MODE=simulation (same MonarchDevice seam the real client fills). */
export class SimulatedMonarch implements MonarchDevice {
  private encoder1: Enc = { mode: "RTMP", state: "READY" } as Enc;
  private encoder2: Enc = { mode: "RECORD", state: "READY" } as Enc;
  private videoInput = "SDI";
  private audioInput = "ANALOG";
  private bitrate = 4000;
  private recordName = "service";
  private rtmp = {
    1: { url: "rtmp://127.0.0.1/live", streamName: "sim", username: undefined as string | undefined },
    2: { url: "rtmp://127.0.0.1/backup", streamName: "sim", username: undefined as string | undefined },
  };

  private enc(n: 1 | 2): Enc {
    return n === 1 ? this.encoder1 : this.encoder2;
  }
  private set(n: 1 | 2, state: string): void {
    (this.enc(n) as { state: string }).state = state;
  }

  async getStatus(): Promise<HDXStatus> {
    return { name: "Simulated Monarch HDX", encoder1: { ...this.encoder1 }, encoder2: { ...this.encoder2 } } as HDXStatus;
  }
  async startEncoder(n: 1 | 2) { this.set(n, "ON"); return undefined; }
  async stopEncoder(n: 1 | 2) { this.set(n, "READY"); return undefined; }
  async startBothEncoders() { this.set(1, "ON"); this.set(2, "ON"); return undefined; }
  async stopBothEncoders() { this.set(1, "READY"); this.set(2, "READY"); return undefined; }
  async getInputStatus(): Promise<InputStatus> {
    return { input: this.videoInput, resolution: "1920x1080p", framerate: 25 } as InputStatus;
  }
  async getVideoInput() { return this.videoInput; }
  async setVideoInput(input: "SDI" | "HDMI") { this.videoInput = input; return undefined; }
  async getAudioInput() { return this.audioInput; }
  async setAudioInput(input: "ANALOG" | "DIGITAL") { this.audioInput = input; return undefined; }
  async getStreamingVideoDataRate() { return this.bitrate; }
  async setStreamingVideoDataRate(kbps: number) { this.bitrate = kbps; return undefined; }
  async getRecordFileName() { return this.recordName; }
  async setRecordFileName(name: string) { this.recordName = name; return undefined; }
  async getEncoderRTMP(n: 1 | 2) { return { ...this.rtmp[n] }; }
  async setEncoderRTMP(n: 1 | 2, config: { url: string; streamName: string }) {
    this.rtmp[n] = { ...this.rtmp[n], ...config };
    return undefined;
  }
}
