import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
// @ts-expect-error plain ESM without types
import { buildRequest, kebab, operations, parseFlags, run } from "../cli/cli.mjs";

const spec = JSON.parse(readFileSync(new URL("../openapi/openapi.json", import.meta.url), "utf8"));

test("every route the app serves is in the OpenAPI document, and the other way round", async () => {
  const app = buildApp(loadConfig({}));
  await app.ready();
  const served = (app as unknown as { routeTable: Set<string> }).routeTable;
  await app.close();
  const documented = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const method of Object.keys(item)) documented.add(`${method.toUpperCase()} ${path}`);
  }
  for (const r of served) assert.ok(documented.has(r), `${r} is served but not documented`);
  for (const d of documented) assert.ok(served.has(d), `${d} is documented but not served`);
});

test("command names are unique kebab-case operation ids", () => {
  const entries = operations(spec) as Array<{ command: string }>;
  assert.equal(new Set(entries.map((e) => e.command)).size, entries.length);
  assert.equal(kebab("setAtemDskOnAir"), "set-atem-dsk-on-air");
});

test("buildRequest fills path, query and body from flags and coerces types", async () => {
  const entries = operations(spec) as Array<{ command: string }>;
  const find = (c: string) => entries.find((e) => e.command === c);
  const dsk = await buildRequest(spec, find("set-atem-dsk-on-air"), parseFlags(["--dsk", "2", "--onAir", "true"]), { baseUrl: "http://gw:3100", apiKey: "k" });
  assert.equal(dsk.method, "PUT");
  assert.equal(dsk.url, "http://gw:3100/api/v1/atem/dsk/2/on-air");
  assert.deepEqual(JSON.parse(dsk.body), { onAir: true });
  assert.equal(dsk.headers["x-api-key"], "k");
  await assert.rejects(buildRequest(spec, find("set-atem-dsk-on-air"), parseFlags(["--dsk", "2"])), /Missing --onAir/);
  await assert.rejects(buildRequest(spec, find("set-atem-dsk-on-air"), parseFlags(["--dsk", "2", "--onAir", "true", "--nope", "1"])), /Unknown option --nope/);
  const still = await buildRequest(spec, find("upload-atem-still"), parseFlags(["--slot", "3", "--name", "a b", "--file", "x.rgba"]), {
    baseUrl: "http://gw:3100",
    readBinary: async () => Buffer.from([1, 2])
  });
  assert.equal(still.url, "http://gw:3100/api/v1/atem/media/stills/3?name=a+b");
  assert.equal(still.headers["content-type"], "application/octet-stream");
});

test("run calls the gateway and sets the exit code from the status", async () => {
  let out = "";
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${url}`);
    return new Response('{"connected":true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const code = await run(["get-atem-state"], { PIGATEWAY_URL: "http://gw:3100" }, spec, { fetchImpl, out: (s: string) => (out += s), err: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["GET http://gw:3100/api/v1/atem"]);
  assert.match(out, /"connected": true/);
  const bad = await run(["nope"], {}, spec, { fetchImpl, out: () => {}, err: () => {} });
  assert.equal(bad, 2);
});
