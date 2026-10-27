import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CameraCgiError, UdpViscaCameraAdapter } from "../src/camera/camera-adapter.js";
import { loadConfig } from "../src/config.js";

const USER = "avstream";
const PASSWORD = "s3cret-pass";
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/**
 * A fake AVer CGI: answers only to the expected Basic login, records what it saw.
 * get_rtmp_status answers with `status` (default streaming) in the body.
 */
async function fakeCamera(status = "rtmp_status=streaming") {
  const seen: Array<{ method: string | undefined; url: string; authorization: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url ?? "", authorization: req.headers.authorization });
    res.statusCode = req.headers.authorization === EXPECTED ? 200 : 401;
    res.end(req.url?.includes("get_rtmp_status") ? status : "ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { server, port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function adapterFor(port: number, auth?: { user: string; password: string }) {
  return new UdpViscaCameraAdapter({
    id: "cam1",
    label: "Camera 1",
    host: "127.0.0.1",
    cgiPort: port,
    rtmpServer: "rtmp://192.168.1.103:1935",
    rtmpKey: "cam1",
    ...(auth ? { auth } : {})
  });
}

test("the Basic login is sent in the Authorization header, never in the URL", async () => {
  const cam = await fakeCamera();
  try {
    const adapter = adapterFor(cam.port, { user: USER, password: PASSWORD });
    await adapter.startStream();
    assert.equal(cam.seen.length, 2, "start and status calls");
    for (const call of cam.seen) {
      assert.equal(call.authorization, EXPECTED);
      assert.ok(!call.url.includes(PASSWORD) && !call.url.includes(USER + ":"), "login must not be in the URL");
    }
    assert.equal(cam.seen[0]!.method, "POST");
    assert.match(cam.seen[0]!.url, /^\/storks\?cmd=set_rtmp_start\(server=rtmp:\/\/192\.168\.1\.103:1935;key=cam1\)$/);
    assert.equal(cam.seen[1]!.method, "GET");
    assert.match(cam.seen[1]!.url, /^\/storks\?cmd=get_rtmp_status\(\d+\)$/);
  } finally {
    await cam.close();
  }
});

test("a wrong login fails the start with reason auth, and the error does not contain the password", async () => {
  const cam = await fakeCamera();
  try {
    const adapter = adapterFor(cam.port, { user: USER, password: "wrong-pass" });
    await assert.rejects(adapter.startStream(), (err: unknown) => {
      assert.ok(err instanceof CameraCgiError);
      assert.equal(err.reason, "auth");
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes("wrong-pass") && !err.message.includes(PASSWORD));
      return true;
    });
    assert.equal(adapter.getSnapshot().streaming, false, "a failed start must not report streaming");
  } finally {
    await cam.close();
  }
});

test("no login configured against a camera that needs one is an auth failure", async () => {
  const cam = await fakeCamera();
  try {
    await assert.rejects(adapterFor(cam.port).startStream(), (err: unknown) => {
      assert.ok(err instanceof CameraCgiError);
      assert.equal(err.reason, "auth");
      return true;
    });
    assert.equal(cam.seen[0]!.authorization, undefined);
  } finally {
    await cam.close();
  }
});

test("a camera that does not answer is reported as unreachable", async () => {
  const cam = await fakeCamera();
  const closedPort = cam.port;
  await cam.close();
  await assert.rejects(adapterFor(closedPort, { user: USER, password: PASSWORD }).startStream(), (err: unknown) => {
    assert.ok(err instanceof CameraCgiError);
    assert.equal(err.reason, "unreachable");
    return true;
  });
});

test("stop sends the disable call with the same login and clears streaming even when it fails", async () => {
  const cam = await fakeCamera();
  try {
    const adapter = adapterFor(cam.port, { user: USER, password: PASSWORD });
    await adapter.startStream();
    await adapter.stopStream();
    const last = cam.seen[cam.seen.length - 1]!;
    assert.equal(last.method, "POST");
    assert.equal(last.url, "/storks?cmd=set_rtmp_stop");
    assert.equal(last.authorization, EXPECTED);
    assert.equal(adapter.getSnapshot().streaming, false);
  } finally {
    await cam.close();
  }
});

test("a status of failed from the camera fails the start, and streaming stays off", async () => {
  const cam = await fakeCamera("rtmp_status=failed");
  try {
    const adapter = adapterFor(cam.port, { user: USER, password: PASSWORD });
    await assert.rejects(adapter.startStream(), (err: unknown) => {
      assert.ok(err instanceof CameraCgiError);
      assert.equal(err.reason, "rejected");
      return true;
    });
    assert.equal(adapter.getSnapshot().streaming, false);
  } finally {
    await cam.close();
  }
});

test("an unrecognised status answer does not fail the start", async () => {
  const cam = await fakeCamera("<html>?</html>");
  try {
    const adapter = adapterFor(cam.port, { user: USER, password: PASSWORD });
    await adapter.startStream();
    assert.equal(adapter.getSnapshot().streaming, true);
  } finally {
    await cam.close();
  }
});

test("without a server and key no RTMP call is made", async () => {
  const cam = await fakeCamera();
  try {
    const adapter = new UdpViscaCameraAdapter({ id: "cam2", label: "Camera 2", host: "127.0.0.1", cgiPort: cam.port });
    await adapter.startStream();
    assert.equal(cam.seen.length, 0);
  } finally {
    await cam.close();
  }
});

test("PIGATEWAY_CAM1_USER without a password is a config error", () => {
  assert.throws(
    () =>
      loadConfig({
        PIGATEWAY_MODE: "simulation",
        PIGATEWAY_DISPLAY_MODE: "simulated",
        PIGATEWAY_CAM1_USER: USER
      }),
    /PIGATEWAY_CAM1_USER and PIGATEWAY_CAM1_PASSWORD must be set together/
  );
});

test("PIGATEWAY_CAM2 login is read when both values are set", () => {
  const config = loadConfig({
    PIGATEWAY_MODE: "simulation",
    PIGATEWAY_DISPLAY_MODE: "simulated",
    PIGATEWAY_CAM2_USER: USER,
    PIGATEWAY_CAM2_PASSWORD: PASSWORD
  });
  assert.equal(config.cam2CgiUser, USER);
  assert.equal(config.cam2CgiPassword, PASSWORD);
});
