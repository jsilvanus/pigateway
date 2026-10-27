import assert from "node:assert/strict";
import { createServer, Socket, type Server } from "node:net";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AmxTcpListener } from "../src/amx/amx-listener.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
  );
}

/** A stand-in for pimatrix's AMX listener: answers STATUS:ALL and OUTPUT:SET, records every line. */
function fakeVideo(): { server: Server; lines: string[] } {
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const line = chunk.split(";")[0] ?? "";
      lines.push(line);
      if (line === "STATUS:ALL") socket.write("STATUS:ALL:mode=prod,hdmi0=hama,cam1pwr=on,atlona=9/9/9/9/9;\r\n");
      else if (line.startsWith("OUTPUT:SET:")) socket.write(`OUTPUT:OK:${line.split(":").slice(2).join(":")};\r\n`);
      else socket.write("ERR:UNKNOWN_COMMAND;\r\n");
    });
  });
  return { server, lines };
}

async function withAmx(
  env: Record<string, string>,
  run: (send: (cmd: string) => Promise<string>, app: ReturnType<typeof buildApp>) => Promise<void>
): Promise<void> {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation", PIGATEWAY_AMX_TCP_PORT: "0", ...env }));
  await app.ready();
  const port = (app as unknown as { amxListener: AmxTcpListener }).amxListener.port as number;
  const client = new Socket();
  client.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    client.connect(port, "127.0.0.1", () => resolve());
    client.on("error", reject);
  });
  const send = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      client.once("data", (chunk: string) => resolve(chunk.trim()));
      client.write(`${cmd};\r\n`);
    });
  try {
    await run(send, app);
  } finally {
    client.destroy();
    await app.close();
  }
}

test("AMX TCP: ping, version, message ids, camera commands and errors", async () => {
  await withAmx({}, async (send) => {
    assert.equal(await send("PING"), "PONG;");
    assert.equal(await send("DEV:VERSION"), "DEV:VERSION:1;");
    assert.equal(await send("r7:PING"), "r7:PONG;");
    assert.equal(await send("CAM:1:POWER:ON"), "CAM:OK:1:POWER:ON;".replace("1:POWER", "cam1:POWER").replace("OK:1", "OK:cam1"));
    assert.equal(await send("CAM:LIST"), "CAM:LIST:cam1=on/simulated,cam2=unknown/simulated;");
    assert.equal(await send("CAM:cam1:PRESET:3"), "CAM:OK:cam1:PRESET:3;");
    assert.equal(await send("CAM:cam1:MOVE:sideways"), "ERR:INVALID_DIRECTION;");
    assert.equal(await send("CAM:cam9:POWER:ON"), "ERR:CAMERA_NOT_FOUND:cam9;");
    assert.equal(await send("OUTPUT:LIST"), "ERR:VIDEO_UNAVAILABLE;");
  });
});

test("AMX TCP: video commands are forwarded and STATUS:ALL merges both sides", async () => {
  const video = fakeVideo();
  const videoPort = await listen(video.server);
  try {
    await withAmx(
      { PIGATEWAY_VIDEO_AMX_HOST: "127.0.0.1", PIGATEWAY_VIDEO_AMX_PORT: String(videoPort) },
      async (send) => {
        assert.equal(await send("OUTPUT:SET:hdmi0:hama"), "OUTPUT:OK:hdmi0:hama;");
        assert.ok(video.lines.includes("OUTPUT:SET:hdmi0:hama"));
        await send("CAM:cam1:POWER:OFF");
        const status = await send("STATUS:ALL");
        assert.match(status, /^STATUS:ALL:/);
        assert.match(status, /hdmi0=hama/);
        assert.match(status, /cam1pwr=standby/, "camera fields come from the gateway, not pimatrix");
        assert.match(status, /atlona=0\/0\/0\/0\/0/, "atlona comes from the gateway");
      }
    );
  } finally {
    video.server.close();
  }
});

test("Matrix route endpoint with simulated AMX and with a TCP NetLinx mock master", async () => {
  const sim = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  try {
    const res = await sim.inject({ method: "POST", url: "/api/v1/matrix/route", payload: { input: 3, output: 2 } });
    assert.equal(res.statusCode, 200);
    assert.equal((await sim.inject("/api/v1/matrix")).json().routes["2"], 3);
    assert.equal((await sim.inject({ method: "POST", url: "/api/v1/matrix/route", payload: { input: 9, output: 2 } })).statusCode, 422);
    const lock = await sim.inject({ method: "PUT", url: "/api/v1/matrix/lock", payload: { locked: true } });
    assert.equal(lock.json().locked, true);
  } finally {
    await sim.close();
  }

  const master = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const m = /ATLONA:ROUTE:([^:]+):(\d+):(\d+);/.exec(chunk);
      if (m) socket.write(`ATLONA:CONFIRMED:${m[1]}:${m[2]}:${m[3]};\r\n`);
    });
  });
  const masterPort = await listen(master);
  const app = buildApp(
    loadConfig({ PIGATEWAY_MODE: "production", PIGATEWAY_AMX_MASTER_HOST: "127.0.0.1", PIGATEWAY_AMX_MASTER_PORT: String(masterPort) })
  );
  try {
    const res = await app.inject({ method: "POST", url: "/api/v1/matrix/route", payload: { input: 3, output: 2 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().confirmed, true);
  } finally {
    await app.close();
    master.close();
  }
});
