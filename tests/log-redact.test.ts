import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { REDACT_PATHS, scrubText, scrubUrl, serializers } from "../src/log/redact.js";

test("scrubUrl removes query, fragment and credentials", () => {
  assert.equal(scrubUrl("/api/v1/x?token=abc#f"), "/api/v1/x");
  assert.equal(scrubUrl("rtmp://user:pw@host:1935/live/key?x=1"), "rtmp://host:1935/live/key");
});

test("scrubText masks secrets and URL queries in error text", () => {
  const out = scrubText("failed GET http://a/b?token=SECRET1 with password=hunter2 and apiKey: SECRET2");
  assert.ok(!/SECRET1|hunter2|SECRET2/.test(out), out);
  assert.match(out, /http:\/\/a\/b/);
});

test("err serializer keeps type, code and scrubbed message only", () => {
  const e = Object.assign(new Error("bad http://h/p?streamKey=ABC"), { code: "ECONNREFUSED", stack: "secret stack" });
  e.stack = "Error: bad http://h/p?streamKey=ABC\n    at x (file.ts:1:1)";
  const s = serializers.err(e);
  assert.equal(s.type, "Error");
  assert.equal(s.message, "bad http://h/p");
  assert.equal(s.code, "ECONNREFUSED");
  assert.ok(!s.stack.includes("ABC"));
});

test("logged objects never carry secrets, transcript text or request bodies", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const app = Fastify({ logger: { level: "info", stream, redact: REDACT_PATHS, serializers } });
  app.log.info({ cfg: { password: "PW1", token: "TK1", streamKey: "SK1", text: "hello world speech", body: "BODY1" } }, "x");
  app.log.info({ req: { method: "GET", url: "/a?apiKey=QK", routeOptions: { url: "/a" }, ip: "10.0.0.5", headers: { authorization: "Bearer AUTH1" } } }, "y");
  await app.close();
  const all = lines.join("");
  for (const leak of ["PW1", "TK1", "SK1", "hello world speech", "BODY1", "QK", "AUTH1"]) {
    assert.ok(!all.includes(leak), `${leak} leaked: ${all}`);
  }
  assert.match(all, /10\.0\.0\.5/);
});
