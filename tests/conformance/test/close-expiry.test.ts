import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneShot, roomDir } from "@agentroom/mcp";
import { deriveRoom, parseShareCode } from "@agentroom/protocol";
import {
  type RelayEvent,
  type RelayHandle,
  type RelayOptions,
  startRelay,
} from "@agentroom/relay-node";
import type { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
  BIN,
  baseEnv,
  call,
  cli,
  closeAll,
  connectMcp,
  until,
} from "./helpers.js";

const ALICE = "alice-c10s";
const BOB = "bob-e4p1";
const CLOSED_TEXT = "The room was closed by its creator.";
const EXPIRED_TEXT = "This room has expired or no longer exists";

/** Relay factory per plan KTD1, taking options so tests can drive the clock and sweep. */
const relayFactory = (opts: Partial<RelayOptions>) =>
  startRelay({ port: 0, ...opts });

let relay: RelayHandle;
let events: RelayEvent[];
let clients: Client[];
let transports: StdioClientTransport[];
const homes: string[] = [];
const needles: string[] = [];

beforeAll(() => {
  if (!existsSync(BIN))
    throw new Error(`build the CLI first: ${BIN} is missing`);
});

afterEach(async () => {
  await closeAll(clients, transports);
  await relay.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), "agentroom-conf-ce-"));
  homes.push(h);
  return h;
};

/** alice runs `up`, bob runs `join`, both start real MCP children. */
async function room(upArgs: string[] = []) {
  clients = [];
  transports = [];
  const homeA = newHome();
  const homeB = newHome();
  const envA = baseEnv(homeA, relay.url);
  const envB = baseEnv(homeB, relay.url);
  const out = await cli(envA, [
    "up",
    "--name",
    ALICE,
    "--agent",
    "codex",
    ...upArgs,
  ]);
  const code = out
    .split("\n")
    .find((l) => l.startsWith("ar1_"))
    ?.trim() as string;
  needles.push(code, ALICE, BOB);
  const { roomId } = deriveRoom(parseShareCode(code));
  await cli(envB, ["join", code, "--name", BOB, "--agent", "codex"]);
  const alice = await connectMcp(envA, roomId, transports);
  const bob = await connectMcp(envB, roomId, transports);
  clients.push(alice, bob);
  for (const c of [alice, bob]) {
    await until(async () => {
      const r = await call(c, "room_status");
      return r.structured.connection === "live" ? true : undefined;
    }, "live");
  }
  return { homeA, homeB, envA, code, roomId, alice, bob };
}

/** Relay events carry only ids, counts and codes (invariant 1). */
function expectBlindLog(roomId: string): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    for (const [k, v] of Object.entries(e)) {
      expect(["event", "room", "members", "code"]).toContain(k);
      if (k === "room") expect(v).toBe(roomId);
    }
    const text = JSON.stringify(e);
    for (const n of needles) expect(text).not.toContain(n);
  }
}

test("AE4: alice's down closes the room for both MCP servers, and the id stays dead", async () => {
  events = [];
  relay = await relayFactory({ log: (e) => events.push(e) });
  const r = await room();
  const marker = `close-${Math.random().toString(16).slice(2)}`;
  needles.push(marker);
  expect(
    (await call(r.bob, "send", { kind: "fyi", body: marker })).isError,
  ).toBe(false);

  const out = await cli(r.envA, ["down"]);
  expect(out).toContain("closed; local state removed");

  for (const c of [r.alice, r.bob]) {
    const text = await until(async () => {
      const res = await call(c, "inbox");
      return res.text.includes(CLOSED_TEXT) ? res.text : undefined;
    }, "closed text");
    expect(text).toContain("agentroom up");
    expect((await call(c, "inbox")).text).toContain(CLOSED_TEXT);
  }
  await until(
    () =>
      !existsSync(roomDir(r.homeA, r.roomId)) &&
      !existsSync(roomDir(r.homeB, r.roomId))
        ? true
        : undefined,
    "room dirs deleted",
  );

  const carol = baseEnv(newHome(), relay.url);
  const err = await cli(carol, ["join", r.code, "--name", "carol"]).then(
    () => undefined,
    (e: { code: number; stderr: string }) => e,
  );
  expect(err?.code).toBe(1);
  expect(err?.stderr).toContain("room not found");

  const create = await oneShot({
    url: relay.url,
    hello: {
      t: "hello",
      room: r.roomId,
      proto: 1,
      create: { closeKey: "pk", meta: "M" },
    },
  });
  expect(create).toMatchObject({ t: "error", code: "room_expired" });
  expect(relay.snapshot(r.roomId)).toBeUndefined();
  expect(events.some((e) => e.event === "room_closed")).toBe(true);
  expectBlindLog(r.roomId);
}, 30_000);

test("AE7: with continuous activity, max age expires the room for both MCP servers", async () => {
  events = [];
  let clock = Date.now();
  relay = await relayFactory({
    log: (e) => events.push(e),
    now: () => clock,
    sweepIntervalMs: 20,
  });
  const r = await room(["--ttl", "1m"]);
  expect(relay.snapshot(r.roomId)?.maxAgeSec).toBe(60);
  for (let i = 0; i < 3; i++) {
    clock += 15_000;
    const res = await call(r.alice, "send", { kind: "fyi", body: `tick ${i}` });
    expect(res.isError).toBe(false);
  }
  clock += 20_000;

  for (const c of [r.alice, r.bob]) {
    await until(async () => {
      const res = await call(c, "inbox");
      return res.text.includes(EXPIRED_TEXT) ? true : undefined;
    }, "expiry text");
    expect(
      (await call(c, "send", { kind: "fyi", body: "late" })).text,
    ).toContain(EXPIRED_TEXT);
  }
  expect(existsSync(roomDir(r.homeA, r.roomId))).toBe(false);
  expect(existsSync(roomDir(r.homeB, r.roomId))).toBe(false);
  expect(relay.snapshot(r.roomId)).toBeUndefined();
  expect(events.some((e) => e.event === "room_expired")).toBe(true);
  expectBlindLog(r.roomId);
}, 30_000);
