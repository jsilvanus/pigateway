import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerCanvaRoutes } from "../src/canva/canva-routes.js";
import { CanvaService } from "../src/canva/canva-service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeEnvironment(options: { failPackage?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let polls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.hostname === "export.canva.com") {
      if (url.pathname === "/redirect.png") return new Response(null, { status: 302, headers: { location: "https://evil.example/x.png" } });
      if (url.pathname === "/text.png") return new Response("not an image");
      return new Response(PNG);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/pipgm/items/canva") return json(201, { id: "canva-1" });
    if (url.pathname.endsWith("/canva/export-package")) return json(202, { taskId: "pg-task" });
    if (url.pathname === "/api/v1/pipgm/tasks/pg-task") {
      polls += 1;
      if (options.failPackage) return json(200, { state: "failed", progress: 0.2, error: "bad zip" });
      return polls < 2
        ? json(200, { state: "preparing", progress: 0.5, pictures: { done: 1, total: 4 }, saved: true, ready: false })
        : json(200, { state: "ready", progress: 1, pictures: { done: 4, total: 4 }, saved: true, ready: true });
    }
    if (url.pathname.endsWith("/playlist")) return json(200, {});
    if (/\/pipelines\/[^/]+$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return json(200, { currentStep: 0, totalSteps: 4, fadeToBlack: false });
    if (url.pathname.endsWith("/control")) return json(200, { currentStep: (body as { stepIndex?: number }).stepIndex ?? 0 });
    return json(404, { error: { message: "nope" } });
  };
  return { calls, fetchFn };
}

async function untilDone(app: ReturnType<typeof Fastify>, taskId: string) {
  for (let i = 0; i < 100; i += 1) {
    const task = (await app.inject({ url: `/api/v1/canva/tasks/${taskId}` })).json();
    if (task.state === "ready" || task.state === "failed") return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task did not finish");
}

test("canva push: downloads pages, hands them to piprogram and reports progress until ready", async () => {
  const env = fakeEnvironment();
  const app = Fastify();
  const routed: Array<[number, number]> = [];
  registerCanvaRoutes(app, new CanvaService({ piprogramUrl: "http://pg", fetchFn: env.fetchFn, pollMs: 1 }), {
    routeMatrix: async (i, o) => (routed.push([i, o]), { success: true })
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/canva/push",
    payload: { title: "Sunday", pages: [{ pageNumber: 2, url: "https://export.canva.com/b.png" }, { pageNumber: 1, url: "https://export.canva.com/a.png" }] }
  });
  assert.equal(res.statusCode, 202);
  const started = res.json();
  assert.match(res.headers.location as string, /\/api\/v1\/canva\/tasks\/ctask_/);
  assert.equal(started.pageCount, 2);

  const finished = await untilDone(app, started.taskId);
  assert.equal(finished.state, "ready");
  assert.equal(finished.progress, 1);
  assert.equal(finished.saved, true);
  assert.deepEqual(finished.pictures, { done: 4, total: 4 });
  assert.deepEqual(finished.downloaded, { done: 2, total: 2 });

  const pkg = env.calls.find((c) => c.path.includes("export-package"))!;
  assert.match(pkg.path, /orientation=landscape,portrait$/);
  const pages = (pkg.body as { pages: Array<{ pageNumber: number; filename: string; mimeType: string }> }).pages;
  assert.deepEqual(pages.map((p) => p.pageNumber), [1, 2]);
  assert.equal(pages[0]!.mimeType, "image/png");

  const setup = await app.inject({ method: "POST", url: "/api/v1/canva/setup", payload: { presentationId: started.presentationId, pipelineId: "pipgm1", matrixRoute: "both_projectors", cueSlide: 2, unblankProjectors: true } });
  assert.equal(setup.statusCode, 200);
  assert.equal(setup.json().currentSlide, 2);
  assert.equal(setup.json().routed, true);
  assert.equal(setup.json().warnings.length, 1, "unblank is reported as not applied without picture mute");
  assert.deepEqual(routed, [[3, 1], [3, 2]]);
  assert.ok(env.calls.some((c) => c.path === "/api/v1/pipgm/pipelines/PiPGM1/playlist" && (c.body as { cueImmediately: boolean }).cueImmediately));

  const goto = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { pipelineId: "pipgm1", action: "gotoPage", page: 3 } });
  assert.equal(goto.json().currentPage, 3);
  const noMute = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "picMute", muted: true } });
  assert.equal(noMute.statusCode, 501);
});

test("canva push: rejects other hosts, plain http and bad pages before doing anything", async () => {
  const env = fakeEnvironment();
  const app = Fastify();
  registerCanvaRoutes(app, new CanvaService({ piprogramUrl: "http://pg", fetchFn: env.fetchFn }));
  for (const pages of [
    [{ url: "https://evil.example/a.png" }],
    [{ url: "http://export.canva.com/a.png" }],
    [{ url: "https://export.canva.com.evil.example/a.png" }],
    [],
    [{ pageNumber: 1, url: "https://export.canva.com/a.png" }, { pageNumber: 1, url: "https://export.canva.com/b.png" }]
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { pages } });
    assert.equal(res.statusCode, 422, JSON.stringify(pages));
  }
  assert.equal(env.calls.length, 0);
});

test("canva push: a redirect off the allowed hosts, a non-image and a piprogram failure all end the task as failed", async () => {
  for (const [url, failPackage, expected] of [
    ["https://export.canva.com/redirect.png", false, /must be https/],
    ["https://export.canva.com/text.png", false, /not a PNG/],
    ["https://export.canva.com/a.png", true, /bad zip/]
  ] as const) {
    const env = fakeEnvironment({ failPackage });
    const app = Fastify();
    registerCanvaRoutes(app, new CanvaService({ piprogramUrl: "http://pg", fetchFn: env.fetchFn, pollMs: 1 }));
    const started = (await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { pages: [{ url }] } })).json();
    const task = await untilDone(app, started.taskId);
    assert.equal(task.state, "failed");
    assert.match(task.error, expected);
    const setup = await app.inject({ method: "POST", url: "/api/v1/canva/setup", payload: { presentationId: started.presentationId, pipelineId: "pipgm1" } });
    assert.ok(setup.statusCode === 404 || setup.statusCode === 409);
  }
});

test("canva picture mute: setup unblanks both projectors, control mutes them, a failing projector is reported", async () => {
  const env = fakeEnvironment();
  const app = Fastify();
  const sent: string[] = [];
  let failing = false;
  registerCanvaRoutes(app, new CanvaService({ piprogramUrl: "http://pg", fetchFn: env.fetchFn, pollMs: 1 }), {
    setPictureMute: async (target, muted) => (sent.push(`${target}:${muted ? "ON" : "OFF"}`), failing && target === "proj2" ? { success: false, message: "no answer" } : { success: true })
  });
  const started = (await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { pages: [{ url: "https://export.canva.com/a.png" }] } })).json();
  await untilDone(app, started.taskId);

  const setup = await app.inject({ method: "POST", url: "/api/v1/canva/setup", payload: { presentationId: started.presentationId, pipelineId: "pipgm1", unblankProjectors: true } });
  assert.deepEqual(sent, ["proj1:OFF", "proj2:OFF"]);
  assert.equal(setup.json().picMute, false);
  assert.deepEqual(setup.json().warnings, []);

  sent.length = 0;
  const mute = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "picMute", muted: true } });
  assert.equal(mute.statusCode, 200);
  assert.deepEqual(sent, ["proj1:ON", "proj2:ON"]);
  assert.equal((await app.inject({ url: "/api/v1/canva/status" })).json().picMute, true);

  failing = true;
  const bad = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "picMute", muted: false } });
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().error.message, /proj2: no answer/);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "picMute" } })).statusCode, 422);
});
