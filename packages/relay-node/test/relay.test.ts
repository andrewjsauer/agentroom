import {
  deriveRoom,
  generateCloseKeyPair,
  type RelayFrame,
  seal,
  signClose,
  ulid,
} from "@agentroom/protocol";
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

async function until(cond: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Send a hello and return the first reply frame. */
async function hello(extra: Record<string, unknown> = {}) {
  const c = await connect();
  c.send({ t: "hello", room: ROOM, proto: 1, ...extra });
  const f = await c.next();
  c.ws.close();
  return f;
}

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
});

describe("expiry", () => {
  test("idle rooms expire: room_expired pushed, closed, tombstoned, then forgotten", async () => {
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
    for (const extra of [{}, { create }]) {
      const c = await connect();
      c.send({ t: "hello", room: ROOM, proto: 1, ...extra });
      expect(await c.next()).toMatchObject({ code: "room_expired" });
    }
    clock += 86_400_000;
    await until(async () => {
      const f = await hello();
      return f.t === "error" && f.code === "room_not_found";
    });
  });
});

describe("expiry on access", () => {
  test("an expired room is not revived by a hello or put before the sweep runs", async () => {
    await start({ idleTtlSec: 10, sweepIntervalMs: 3_600_000 });
    const { c: a } = await createRoom();
    clock += 10_000;
    const late = await connect();
    late.send({ t: "hello", room: ROOM, proto: 1 });
    expect(await late.next()).toMatchObject({ code: "room_expired" });
    expect(await a.next()).toMatchObject({ t: "error", code: "room_expired" });
    expect(relay.snapshot(ROOM)).toBeUndefined();

    const { c: b } = await createRoom("b".repeat(64));
    clock += 10_000;
    b.send({ t: "put", blob: "AAAA" });
    expect(await b.next()).toMatchObject({ t: "error", code: "room_expired" });
    expect(relay.snapshot("b".repeat(64))).toBeUndefined();
  });
});

async function closeOnly(room = ROOM) {
  const c = await connect();
  c.send({ t: "hello", room, proto: 1, closeOnly: true });
  const welcome = await c.next();
  if (welcome.t !== "welcome") throw new Error(JSON.stringify(welcome));
  return { c, nonce: welcome.nonce, welcome };
}

describe("close", () => {
  test("a valid close from a close-only connection closes everyone and tombstones", async () => {
    await start();
    const kp = await generateCloseKeyPair();
    const { c: a } = await createRoom(ROOM, { closeKey: kp.publicKey });
    const { c: b } = await joinRoom();
    a.frames.length = 0;
    const { c, nonce } = await closeOnly();
    c.send({ t: "close", sig: await signClose(kp.secretKey, ROOM, nonce) });
    for (const x of [a, b, c]) {
      let f = await x.next();
      while (f.t !== "closed") f = await x.next();
      await x.closed;
    }
    expect(relay.snapshot(ROOM)).toBeUndefined();
    expect(events).toContainEqual({ event: "room_closed", room: ROOM });
    for (const extra of [{}, { create }]) {
      const d = await connect();
      d.send({ t: "hello", room: ROOM, proto: 1, ...extra });
      expect(await d.next()).toMatchObject({ code: "room_expired" });
    }
  });

  test("a non-creator key, a replayed nonce, or a malformed sig gets bad_signature", async () => {
    await start();
    const kp = await generateCloseKeyPair();
    const other = await generateCloseKeyPair();
    const { c: a } = await createRoom(ROOM, { closeKey: kp.publicKey });
    const first = await closeOnly();
    const replayed = await signClose(kp.secretKey, ROOM, first.nonce);
    const sigs = [
      async (n: string) => signClose(other.secretKey, ROOM, n),
      async () => replayed,
      async () => "",
      async () => "not base64!",
    ];
    for (const make of sigs) {
      const { c, nonce } = await closeOnly();
      c.send({ t: "close", sig: await make(nonce) });
      expect(await c.next()).toMatchObject({ code: "bad_signature" });
      await c.closed;
    }
    expect(relay.snapshot(ROOM)).toBeDefined();
    expect(a.frames.some((f) => f.t === "closed")).toBe(false);
  });

  test("close-only is admitted at the cap, is not counted, gets no msgs, and may only close", async () => {
    await start({ maxMembers: 2 });
    const { c: a } = await createRoom();
    const { c, welcome } = await closeOnly();
    expect(welcome.members).toBe(1);
    const { c: b, welcome: bw } = await joinRoom();
    expect(bw).toMatchObject({ t: "welcome", members: 2 });
    expect(await a.next()).toEqual({ t: "presence", members: 2 });
    const { welcome: atCap } = await closeOnly();
    expect(atCap.members).toBe(2);
    a.send({ t: "put", blob: "AAAA" });
    a.send({ t: "put", blob: "BBBB" });
    expect(await b.next()).toMatchObject({ t: "msg", seq: 1 });
    expect(await b.next()).toMatchObject({ t: "msg", seq: 2 });
    expect(c.frames).toEqual([]);
    c.send({ t: "put", blob: "AAAA" });
    expect(await c.next()).toMatchObject({ code: "bad_proto" });
    await c.closed;
  });

  test("close-only connections never evict each other; the per-address cap refuses more", async () => {
    await start({ maxRoomConnsPerIp: 4 });
    await createRoom();
    const first = await closeOnly();
    await closeOnly();
    await closeOnly();
    const c = await connect();
    c.send({ t: "hello", room: ROOM, proto: 1, closeOnly: true });
    expect(await c.next()).toMatchObject({ code: "room_full" });
    await c.closed;
    expect(first.c.frames).toEqual([]);
    expect(first.c.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("an idle close-only connection is closed after the grace period", async () => {
    await start({ closeGraceMs: 20 });
    await createRoom();
    const { c } = await closeOnly();
    await c.closed;
  });

  test.each([
    ["create", { create }],
    ["since", { since: 0 }],
  ])("closeOnly with %s gets bad_proto", async (_n, extra) => {
    await start();
    await createRoom();
    const c = await connect();
    c.send({ t: "hello", room: ROOM, proto: 1, closeOnly: true, ...extra });
    expect(await c.next()).toMatchObject({ code: "bad_proto" });
  });
});

describe("max age, rate limit, cap", () => {
  test("maxAgeSec is capped at the relay default and defaults to it", async () => {
    await start({ maxAgeSec: 100 });
    await createRoom(ROOM, { maxAgeSec: 1000 });
    expect(relay.snapshot(ROOM)?.maxAgeSec).toBe(100);
    await createRoom("b".repeat(64));
    expect(relay.snapshot("b".repeat(64))?.maxAgeSec).toBe(100);
  });

  test("welcome.expiresAt is the earlier of idle and max-age deadlines", async () => {
    await start({ idleTtlSec: 100 });
    const { welcome } = await createRoom(ROOM, { maxAgeSec: 50 });
    expect(welcome).toMatchObject({ expiresAt: clock + 50_000 });
    const { welcome: w2 } = await createRoom("b".repeat(64), {
      maxAgeSec: 500,
    });
    expect(w2).toMatchObject({ expiresAt: clock + 100_000 });
  });

  test("an active room still expires at max age", async () => {
    await start({
      idleTtlSec: 100,
      sweepIntervalMs: 10,
      rateLimit: { burst: 100, perSec: 100 },
    });
    const { c: a } = await createRoom(ROOM, { maxAgeSec: 60 });
    const { c: b } = await joinRoom();
    for (let i = 0; i < 6; i++) {
      clock += 9_000;
      a.send({ t: "put", blob: "AAAA" });
      let f = await a.next();
      while (f.t !== "msg") f = await a.next();
    }
    expect(relay.snapshot(ROOM)).toBeDefined();
    clock += 7_000;
    for (const x of [a, b]) {
      let f = await x.next();
      while (!(f.t === "error" && f.code === "room_expired"))
        f = await x.next();
      await x.closed;
    }
    expect(relay.snapshot(ROOM)).toBeUndefined();
  });

  test("rate limit refuses without closing, is per connection, and refills", async () => {
    await start({ rateLimit: { burst: 3, perSec: 1 } });
    const { c: a } = await createRoom();
    const { c: b } = await joinRoom();
    await a.next(); // presence
    for (let i = 0; i < 3; i++) {
      a.send({ t: "put", blob: "AAAA" });
      await a.next();
      await b.next();
    }
    a.send({ t: "put", blob: "BBBB" });
    expect(await a.next()).toMatchObject({ code: "rate_limited" });
    expect(relay.snapshot(ROOM)?.seq).toBe(3);
    b.send({ t: "put", blob: "CCCC" });
    expect(await a.next()).toMatchObject({ t: "msg", seq: 4 });
    clock += 1_000;
    a.send({ t: "put", blob: "DDDD" });
    expect(await a.next()).toMatchObject({ t: "msg", seq: 5 });
  });

  test("a join over maxMembers gets room_full; after a leave it succeeds", async () => {
    await start({ maxMembers: 2 });
    await createRoom();
    const { c: b } = await joinRoom();
    const c = await connect();
    c.send({ t: "hello", room: ROOM, proto: 1 });
    expect(await c.next()).toMatchObject({ code: "room_full" });
    await c.closed;
    b.ws.close();
    await b.closed;
    await until(async () => (await hello()).t === "welcome");
  });
});

test("invariant 1: stored state, errors and logs hold no plaintext, sig or blob", async () => {
  await start({ maxMembers: 1, rateLimit: { burst: 1, perSec: 0.001 } });
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
  const errors: RelayFrame[] = [];
  const { c: a } = await createRoom(roomId);
  a.send({ t: "put", blob });
  expect(await a.next()).toMatchObject({ t: "msg", seq: 1 });
  a.send({ t: "put", blob });
  const limited = await a.next();
  expect(limited).toMatchObject({ code: "rate_limited" });
  errors.push(limited);
  const full = await connect();
  full.send({ t: "hello", room: roomId, proto: 1 });
  const fullErr = await full.next();
  expect(fullErr).toMatchObject({ code: "room_full" });
  errors.push(fullErr);
  const snap = relay.snapshot(roomId);
  expect(snap?.seq).toBe(1);
  expect(JSON.stringify(snap)).not.toContain(marker);
  for (const e of snap?.buffer ?? []) {
    expect(Buffer.from(e.blob, "base64").toString("latin1")).not.toContain(
      marker,
    );
  }

  const kp = await generateCloseKeyPair();
  const { roomId: r2 } = deriveRoom(new Uint8Array(32).fill(8));
  await createRoom(r2, { closeKey: kp.publicKey });
  const bad = await closeOnly(r2);
  const badSig = await signClose(
    (await generateCloseKeyPair()).secretKey,
    r2,
    bad.nonce,
  );
  bad.c.send({ t: "close", sig: badSig });
  const badErr = await bad.c.next();
  expect(badErr).toMatchObject({ code: "bad_signature" });
  errors.push(badErr);
  const { c, nonce } = await closeOnly(r2);
  const sig = await signClose(kp.secretKey, r2, nonce);
  expect(JSON.stringify(relay.snapshot(r2))).not.toContain(sig);
  c.send({ t: "close", sig });
  expect(await c.next()).toEqual({ t: "closed" });
  await c.closed;
  expect(relay.snapshot(r2)).toBeUndefined();
  expect(events).toContainEqual({ event: "room_closed", room: r2 });

  for (const text of [JSON.stringify(events), JSON.stringify(errors)]) {
    for (const secretText of [sig, badSig, marker, blob, "META"]) {
      expect(text).not.toContain(secretText);
    }
  }
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
