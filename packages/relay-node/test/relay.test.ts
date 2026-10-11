import { deriveRoom, type RelayFrame, seal, ulid } from "@agentroom/protocol";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { type RelayEvent, type RelayHandle, startRelay } from "../src/index.js";

const ROOM = "a".repeat(64);
let relay: RelayHandle;
let clock = 1_000_000;
let events: RelayEvent[] = [];
const open: WebSocket[] = [];

async function start(opts: Record<string, unknown> = {}) {
  clock = 1_000_000;
  events = [];
  relay = await startRelay({
    port: 0,
    now: () => clock,
    log: (e) => events.push(e),
    ...opts,
  });
  return relay;
}

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay?.close();
});

interface Client {
  ws: WebSocket;
  next(): Promise<RelayFrame>;
  frames: RelayFrame[];
  closed: Promise<void>;
  send(frame: unknown): void;
}

async function connect(): Promise<Client> {
  const ws = new WebSocket(relay.url);
  open.push(ws);
  const frames: RelayFrame[] = [];
  const waiters: ((f: RelayFrame) => void)[] = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString()) as RelayFrame;
    const w = waiters.shift();
    if (w) w(f);
    else frames.push(f);
  });
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    frames,
    closed,
    next: () => {
      const f = frames.shift();
      return f ? Promise.resolve(f) : new Promise((r) => waiters.push(r));
    },
    send: (frame) => ws.send(JSON.stringify(frame)),
  };
}

const create = { closeKey: "pk", meta: "META" };

async function createRoom(room = ROOM, extra: Record<string, unknown> = {}) {
  const c = await connect();
  c.send({ t: "hello", room, proto: 1, create: { ...create, ...extra } });
  const welcome = await c.next();
  return { c, welcome };
}

async function joinRoom(since?: number) {
  const c = await connect();
  c.send({ t: "hello", room: ROOM, proto: 1, since });
  const welcome = await c.next();
  return { c, welcome };
}

describe("create and join", () => {
  test("create returns a welcome with seq 0, members 1, meta, nonce, expiresAt", async () => {
    await start();
    const { welcome } = await createRoom();
    expect(welcome).toMatchObject({
      t: "welcome",
      seq: 0,
      members: 1,
      meta: "META",
      expiresAt: clock + 28_800_000,
    });
    if (welcome.t !== "welcome") throw new Error();
    expect(Buffer.from(welcome.nonce, "base64").length).toBeGreaterThanOrEqual(
      16,
    );
  });

  test("second create gets room_exists; unknown join gets room_not_found and closes", async () => {
    await start();
    await createRoom();
    const again = await createRoom();
    expect(again.welcome).toMatchObject({ t: "error", code: "room_exists" });
    const c = await connect();
    c.send({ t: "hello", room: "b".repeat(64), proto: 1 });
    expect(await c.next()).toMatchObject({
      t: "error",
      code: "room_not_found",
    });
    await c.closed;
  });

  test("idleTtlSec above the relay default is capped", async () => {
    await start({ idleTtlSec: 60 });
    const { welcome } = await createRoom(ROOM, { idleTtlSec: 999_999 });
    expect(welcome).toMatchObject({ expiresAt: clock + 60_000 });
    expect(relay.snapshot(ROOM)?.idleTtlSec).toBe(60);
  });

  test("each connection gets a fresh nonce", async () => {
    await start();
    const a = await createRoom();
    const b = await joinRoom();
    if (a.welcome.t !== "welcome" || b.welcome.t !== "welcome")
      throw new Error();
    expect(a.welcome.nonce).not.toBe(b.welcome.nonce);
  });
});

describe("messages", () => {
  test("put arrives at both sender and peer with increasing seq", async () => {
    await start();
    const { c: a } = await createRoom();
    const { c: b } = await joinRoom();
    expect(await a.next()).toEqual({ t: "presence", members: 2 });
    a.send({ t: "put", blob: "AAAA" });
    expect(await a.next()).toEqual({ t: "msg", seq: 1, blob: "AAAA" });
    expect(await b.next()).toEqual({ t: "msg", seq: 1, blob: "AAAA" });
    b.send({ t: "put", blob: "BBBB" });
    expect(await a.next()).toEqual({ t: "msg", seq: 2, blob: "BBBB" });
  });

  test("since replays newer seqs before live; no since replays nothing", async () => {
    await start();
    const { c: a } = await createRoom();
    for (let i = 1; i <= 5; i++) {
      a.send({ t: "put", blob: `B${i}AA` });
      await a.next();
    }
    const { c: b, welcome } = await joinRoom(2);
    expect(welcome).toMatchObject({ seq: 5 });
    a.send({ t: "put", blob: "B6AA" });
    const seqs = [];
    for (let i = 0; i < 4; i++) {
      const f = await b.next();
      if (f.t === "msg") seqs.push(f.seq);
    }
    expect(seqs).toEqual([3, 4, 5, 6]);
    const { c: d, welcome: w2 } = await joinRoom();
    expect(w2).toMatchObject({ seq: 6 });
    a.send({ t: "put", blob: "B7AA" });
    expect(await d.next()).toEqual({ t: "msg", seq: 7, blob: "B7AA" });
  });

  test("buffer keeps the last 500", async () => {
    await start();
    const { c: a } = await createRoom();
    for (let i = 0; i < 502; i++) relay.inject(ROOM, "AAAA");
    a.frames.length = 0;
    const { c: b } = await joinRoom(0);
    const first = await b.next();
    expect(first).toMatchObject({ t: "msg", seq: 3 });
    expect(relay.snapshot(ROOM)?.buffer).toHaveLength(500);
    expect(relay.snapshot(ROOM)?.buffer.at(-1)?.seq).toBe(502);
  });

  test("connect and disconnect broadcast presence", async () => {
    await start();
    const { c: a } = await createRoom();
    const { c: b } = await joinRoom();
    expect(await a.next()).toEqual({ t: "presence", members: 2 });
    b.ws.close();
    expect(await a.next()).toEqual({ t: "presence", members: 1 });
  });
});

describe("limits and protocol errors", () => {
  test("too_large over 64 KiB decoded; exactly 64 KiB accepted", async () => {
    await start();
    const { c: a } = await createRoom();
    a.send({ t: "put", blob: Buffer.alloc(65_537).toString("base64") });
    expect(await a.next()).toMatchObject({ t: "error", code: "too_large" });
    expect(relay.snapshot(ROOM)?.seq).toBe(0);
    a.send({ t: "put", blob: Buffer.alloc(65_536).toString("base64") });
    expect(await a.next()).toMatchObject({ t: "msg", seq: 1 });
  });

  test("a frame over 96 KiB is refused by ws", async () => {
    await start();
    const { c: a } = await createRoom();
    a.send({ t: "put", blob: "A".repeat(100 * 1024) });
    await a.closed;
    expect(relay.snapshot(ROOM)?.seq).toBe(0);
  });

  test.each([
    ["invalid JSON", "{nope", false],
    ["proto 2", JSON.stringify({ t: "hello", room: ROOM, proto: 2 }), false],
    ["put before hello", JSON.stringify({ t: "put", blob: "AAAA" }), false],
    [
      "a second hello",
      JSON.stringify({ t: "hello", room: ROOM, proto: 1 }),
      true,
    ],
  ])("%s gets bad_proto and closes", async (_name, raw, afterHello) => {
    await start();
    await createRoom();
    const c = await connect();
    if (afterHello) {
      c.send({ t: "hello", room: ROOM, proto: 1 });
      await c.next();
    }
    c.ws.send(raw as string);
    let f = await c.next();
    while (f.t === "presence") f = await c.next();
    expect(f).toMatchObject({ t: "error", code: "bad_proto" });
    await c.closed;
  });

  test("close gets bad_proto with the M2 message and the room survives", async () => {
    await start();
    const { c: a } = await createRoom();
    a.send({ t: "close", sig: "c2ln" });
    expect(await a.next()).toEqual({
      t: "error",
      code: "bad_proto",
      message: "close is not supported until protocol M2",
    });
    expect(relay.snapshot(ROOM)).toBeDefined();
  });
});

describe("expiry", () => {
  test("idle rooms expire: room_expired pushed, closed, then room_not_found", async () => {
    await start({ idleTtlSec: 10, sweepIntervalMs: 10 });
    const { c: a } = await createRoom();
    clock += 9_000;
    a.send({ t: "put", blob: "AAAA" });
    await a.next();
    clock += 9_000; // 18 s after creation, 9 s after the put: still alive
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.snapshot(ROOM)).toBeDefined();
    clock += 1_000;
    expect(await a.next()).toMatchObject({ t: "error", code: "room_expired" });
    await a.closed;
    expect(relay.snapshot(ROOM)).toBeUndefined();
    const c = await connect();
    c.send({ t: "hello", room: ROOM, proto: 1 });
    expect(await c.next()).toMatchObject({ code: "room_not_found" });
  });
});

test("invariant 1: stored state and logs hold no plaintext", async () => {
  await start();
  const secret = new Uint8Array(32).fill(9);
  const { roomId, key } = deriveRoom(secret);
  const marker = `MARKER-${ulid()}`;
  const blob = await seal(
    {
      v: 1,
      id: ulid(),
      ts: 1,
      from: { member: "alice", agent: "codex", via: "mcp" },
      kind: "fyi",
      thread: "t",
      body: marker,
    },
    key,
    roomId,
  );
  const { c: a } = await createRoom(roomId);
  a.send({ t: "put", blob });
  await a.next();
  const snap = relay.snapshot(roomId);
  expect(JSON.stringify(snap)).not.toContain(marker);
  for (const e of snap?.buffer ?? []) {
    expect(Buffer.from(e.blob, "base64").toString("latin1")).not.toContain(
      marker,
    );
  }
  const logged = JSON.stringify(events);
  expect(logged).not.toContain(marker);
  expect(logged).not.toContain(blob);
  expect(logged).not.toContain("META");
});

test("setAccepting, disconnectAll and inject", async () => {
  await start();
  const { c: a } = await createRoom();
  relay.setAccepting(false);
  relay.disconnectAll();
  await a.closed;
  await expect(connect()).rejects.toThrow();
  relay.setAccepting(true);
  const { c: b } = await joinRoom();
  relay.inject(ROOM, "QUFB");
  expect(await b.next()).toEqual({ t: "msg", seq: 1, blob: "QUFB" });
});
