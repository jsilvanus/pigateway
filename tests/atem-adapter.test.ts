import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AtemAdapter, type AtemClient } from "../src/atem/atem-adapter.js";
import { loadConfig } from "../src/config.js";

/** A fake atem-connection client: no sockets, state and events driven by the test. */
class FakeAtem extends EventEmitter implements AtemClient {
  state: unknown = undefined;
  calls: Array<[string, ...unknown[]]> = [];
  connectArgs: [string, number | undefined] | null = null;

  async connect(address: string, port?: number): Promise<void> {
    this.connectArgs = [address, port];
  }
  async disconnect(): Promise<void> {
    this.calls.push(["disconnect"]);
  }
  async changeProgramInput(input: number, me?: number): Promise<void> {
    this.calls.push(["changeProgramInput", input, me]);
  }
  async changePreviewInput(input: number, me?: number): Promise<void> {
    this.calls.push(["changePreviewInput", input, me]);
  }
  async cut(me?: number): Promise<void> {
    this.calls.push(["cut", me]);
  }
}

function makeAdapter(meIndex?: number) {
  const fakes: FakeAtem[] = [];
  const adapter = new AtemAdapter({
    ...(meIndex !== undefined ? { meIndex } : {}),
    createClient: () => {
      const fake = new FakeAtem();
      fakes.push(fake);
      return fake;
    },
  });
  return { adapter, fakes };
}

test("stub adapter without a host reports disconnected and opens nothing", async () => {
  const { adapter, fakes } = makeAdapter();
  await adapter.connect(undefined);
  await adapter.connect("   ");

  assert.equal(fakes.length, 0);
  assert.deepEqual(adapter.getState(), {
    connected: false,
    programInput: null,
    previewInput: null,
    transition: { inTransition: false, remainingFrames: 0 },
    fadeToBlack: { fullyBlack: false, inTransition: false, remainingFrames: 0 },
    downstreamKeyers: [],
  });
});

test("stub adapter switching commands are no-ops", async () => {
  const { adapter, fakes } = makeAdapter();
  await adapter.setProgram(1);
  await adapter.setPreview(2);
  await adapter.cut();

  assert.equal(fakes.length, 0);
  assert.equal(adapter.getState().connected, false);
});

test("switching input numbers must be positive integers", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(adapter.setProgram(0), RangeError);
  await assert.rejects(adapter.setPreview(1.5), RangeError);
});

test("connected state is read from the M/E row, as plain data", async () => {
  const { adapter, fakes } = makeAdapter(1);
  await adapter.connect("192.0.2.10", 9991);
  const [fake] = fakes;
  assert.ok(fake);
  assert.deepEqual(fake.connectArgs, ["192.0.2.10", 9991]);

  fake.state = {
    video: {
      mixEffects: [
        { programInput: 9, previewInput: 9 },
        { programInput: 3, previewInput: 4, transitionPosition: { inTransition: true, remainingFrames: 12 } },
      ],
    },
  };
  fake.emit("connected");

  const state = adapter.getState();
  assert.deepEqual(state, {
    connected: true,
    programInput: 3,
    previewInput: 4,
    transition: { inTransition: true, remainingFrames: 12 },
    fadeToBlack: { fullyBlack: false, inTransition: false, remainingFrames: 0 },
    downstreamKeyers: [],
  });
  assert.deepEqual(Object.keys(state).sort(), ["connected", "downstreamKeyers", "fadeToBlack", "previewInput", "programInput", "transition"]);
});

test("state change listeners receive the new state and can unsubscribe", async () => {
  const { adapter, fakes } = makeAdapter();
  await adapter.connect("192.0.2.10");
  const [fake] = fakes;
  assert.ok(fake);
  const seen: Array<boolean> = [];
  const unsubscribe = adapter.onStateChange((state) => seen.push(state.connected));

  fake.emit("connected");
  fake.state = { video: { mixEffects: [{ programInput: 2, previewInput: 5 }] } };
  fake.emit("stateChanged");
  unsubscribe();
  fake.emit("disconnected");

  assert.deepEqual(seen, [true, true]);
  assert.equal(adapter.getState().connected, false);
});

test("commands are forwarded to the M/E index and refused while not connected", async () => {
  const { adapter, fakes } = makeAdapter(1);
  await adapter.connect("192.0.2.10");
  const [fake] = fakes;
  assert.ok(fake);

  await assert.rejects(adapter.setProgram(2), /not connected/);

  fake.emit("connected");
  await adapter.setProgram(2);
  await adapter.setPreview(3);
  await adapter.cut();
  assert.deepEqual(fake.calls, [
    ["changeProgramInput", 2, 1],
    ["changePreviewInput", 3, 1],
    ["cut", 1],
  ]);
});

test("loadConfig reads the ATEM host and defaults the port to 9910", () => {
  const unset = loadConfig({});
  assert.equal(unset.atemHost, undefined);
  assert.equal(unset.atemPort, 9910);

  const set = loadConfig({ PIGATEWAY_ATEM_HOST: " 192.0.2.20 ", PIGATEWAY_ATEM_PORT: "9991" });
  assert.equal(set.atemHost, "192.0.2.20");
  assert.equal(set.atemPort, 9991);

  assert.throws(() => loadConfig({ PIGATEWAY_ATEM_PORT: "70000" }), /PIGATEWAY_ATEM_PORT/);
});

test("connect logs a warning when the ATEM is not confirmed in time", async () => {
  const warnings: Array<[object, string]> = [];
  const logger = { warn: (obj: object, msg: string) => void warnings.push([obj, msg]) };
  const fakes: FakeAtem[] = [];
  const adapter = new AtemAdapter({
    logger,
    connectWarnMs: 10,
    createClient: () => {
      const fake = new FakeAtem();
      fakes.push(fake);
      return fake;
    }
  });
  await adapter.connect("192.0.2.20");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]![1], /not connected after 10 ms/);
  assert.deepEqual(fakes[0]!.connectArgs, ["192.0.2.20", 9910]);
  await adapter.disconnect();
});

test("connect logs a warning and rethrows when the connection fails", async () => {
  const warnings: string[] = [];
  const logger = { warn: (_obj: object, msg: string) => void warnings.push(msg) };
  const adapter = new AtemAdapter({
    logger,
    createClient: () => {
      const fake = new FakeAtem();
      fake.connect = async () => {
        throw new Error("no route");
      };
      return fake;
    }
  });
  await assert.rejects(adapter.connect("192.0.2.20"), /no route/);
  assert.deepEqual(warnings, ["ATEM connection failed"]);
});

test("a dropped ATEM is reconnected to the same address with backoff, and the log says so", async () => {
  const infos: string[] = [];
  const warns: string[] = [];
  const logger = {
    warn: (_obj: object, msg: string) => void warns.push(msg),
    info: (_obj: object, msg: string) => void infos.push(msg)
  };
  const fakes: FakeAtem[] = [];
  const adapter = new AtemAdapter({
    logger,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    createClient: () => {
      const fake = new FakeAtem();
      fakes.push(fake);
      return fake;
    }
  });
  await adapter.connect("192.0.2.30");
  fakes[0]!.emit("connected");
  fakes[0]!.emit("disconnected");
  assert.deepEqual(warns, ["ATEM disconnected"]);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fakes.length, 2);
  assert.deepEqual(fakes[1]!.connectArgs, ["192.0.2.30", 9910]);

  fakes[1]!.emit("connected");
  assert.equal(adapter.getState().connected, true);
  assert.ok(infos.includes("ATEM connected"));
  assert.ok(infos.some((msg) => msg === "ATEM reconnect scheduled"));
  await adapter.disconnect();
});

test("reconnect keeps trying while the ATEM refuses, and disconnect() stops it", async () => {
  const fakes: FakeAtem[] = [];
  const adapter = new AtemAdapter({
    reconnectMinMs: 5,
    reconnectMaxMs: 10,
    createClient: () => {
      const fake = new FakeAtem();
      if (fakes.length > 0) {
        fake.connect = async () => {
          throw new Error("unreachable");
        };
      }
      fakes.push(fake);
      return fake;
    }
  });
  await adapter.connect("192.0.2.31");
  fakes[0]!.emit("connected");
  fakes[0]!.emit("disconnected");

  await new Promise((resolve) => setTimeout(resolve, 60));
  const beforeStop = fakes.length;
  assert.ok(beforeStop >= 3, `expected several retries, got ${beforeStop}`);

  await adapter.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fakes.length, beforeStop, "no attempts after disconnect()");
});
