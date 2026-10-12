import { generateCloseKeyPair, signClose } from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  backoffDelay,
  connectOnce,
  type GoneCode,
  oneShot,
  RelayClient,
  RelayError,
} from "../src/index.js";

const ROOM = "e".repeat(64);
let relay: RelayHandle;
let clock = 1_000_000;
const clients: RelayClient[] = [];

beforeEach(async () => {
  clock = 1_000_000;
  relay = await startRelay({
    port: 0,
    now: () => clock,
    log: () => {},
    idleTtlSec: 10,
    sweepIntervalMs: 10,
  });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await relay.close();
});

async function createRoom(closeKey = "pk"): Promise<void> {
  const res = await oneShot({
    url: relay.url,
    hello: {
      t: "hello",
      room: ROOM,
      proto: 1,
      create: { closeKey, meta: "M" },
    },
  });
  expect(res.t).toBe("welcome");
}

function client(initialSince = 0) {
  const msgs: number[] = [];
  const gone: GoneCode[] = [];
  const errors: string[] = [];
  let welcomes = 0;
  const c = new RelayClient({
    url: relay.url,
    roomId: ROOM,
    initialSince,
    onWelcome: () => {
      welcomes++;
    },
    onMsg: (seq) => msgs.push(seq),
    onPresence: () => {},
    onGone: (code) => gone.push(code),
    onError: (code) => errors.push(code),
    backoff: { initialMs: 5, maxMs: 20 },
  });
  clients.push(c);
  c.start();
  return { c, msgs, gone, errors, welcomes: () => welcomes };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("first connect sends since 0 and receives buffered messages in order", async () => {
  await createRoom();
  for (let i = 0; i < 3; i++) relay.inject(ROOM, "AAAA");
  const { msgs } = client();
  await until(() => msgs.length === 3);
  expect(msgs).toEqual([1, 2, 3]);
});

test("reconnects after a drop and resumes from the last seq (AE2)", async () => {
  await createRoom();
  for (let i = 0; i < 4; i++) relay.inject(ROOM, "AAAA");
  const { c, msgs, welcomes } = client();
  await until(() => msgs.length === 4);
  relay.setAccepting(false);
  relay.disconnectAll();
  await until(() => c.state === "backoff");
  relay.inject(ROOM, "BBBB");
  relay.setAccepting(true);
  await until(() => msgs.length === 5 && c.state === "live");
  expect(msgs).toEqual([1, 2, 3, 4, 5]);
  expect(welcomes()).toBe(2);
});

test("backoff doubles from 500 ms with full jitter and caps at 30 s", () => {
  const max = (n: number) =>
    backoffDelay(n, undefined, undefined, () => 0.999999);
  expect(max(0)).toBeLessThan(500);
  expect(max(1)).toBeGreaterThan(max(0));
  expect(max(5)).toBeGreaterThan(max(4));
  expect(max(20)).toBeLessThan(30_000);
  expect(max(20)).toBeGreaterThan(29_999);
  expect(backoffDelay(3, 500, 30_000, () => 0)).toBe(0);
});

test("refused connections keep retrying in backoff", async () => {
  await createRoom();
  relay.setAccepting(false);
  const { c, welcomes } = client();
  await until(() => c.state === "backoff");
  await new Promise((r) => setTimeout(r, 60));
  expect(welcomes()).toBe(0);
  relay.setAccepting(true);
  await until(() => c.state === "live");
});

test("room_not_found calls onGone once and stops connecting", async () => {
  const { c, gone } = client();
  await until(() => gone.length === 1);
  expect(gone).toEqual(["room_not_found"]);
  expect(c.state).toBe("gone");
  await new Promise((r) => setTimeout(r, 60));
  expect(gone).toHaveLength(1);
  expect(c.state).toBe("gone");
});

test("relay-pushed room_expired calls onGone and stops", async () => {
  await createRoom();
  const { c, gone } = client();
  await until(() => c.state === "live");
  clock += 11_000;
  await until(() => gone.length === 1);
  expect(gone).toEqual(["room_expired"]);
  expect(c.state).toBe("gone");
});

test("put while not live rejects with relay unreachable", async () => {
  await createRoom();
  relay.setAccepting(false);
  const { c } = client();
  await until(() => c.state === "backoff");
  await expect(c.put("AAAA")).rejects.toThrow(/unreachable/);
});

test("oneShot returns welcome for create and room_not_found for unknown", async () => {
  await createRoom();
  const res = await oneShot({
    url: relay.url,
    hello: { t: "hello", room: "f".repeat(64), proto: 1 },
  });
  expect(res).toMatchObject({ t: "error", code: "room_not_found" });
});

const hello = (extra: Record<string, unknown> = {}) => ({
  t: "hello" as const,
  room: ROOM,
  proto: 1 as const,
  ...extra,
});

async function closeRoom(secretKey: string): Promise<void> {
  const s = await connectOnce({
    url: relay.url,
    hello: hello({ closeOnly: true }),
  });
  await s.close(await signClose(secretKey, ROOM, s.welcome.nonce));
}

test("closed: onGone('closed') once, state gone, no reconnect", async () => {
  const kp = await generateCloseKeyPair();
  await createRoom(kp.publicKey);
  const { c, gone, welcomes } = client();
  await until(() => c.state === "live");
  await closeRoom(kp.secretKey);
  await until(() => gone.length === 1);
  expect(gone).toEqual(["closed"]);
  expect(c.state).toBe("gone");
  await new Promise((r) => setTimeout(r, 50));
  expect(welcomes()).toBe(1);
});

test("rate_limited reaches onError and the connection stays live", async () => {
  await relay.close();
  relay = await startRelay({
    port: 0,
    log: () => {},
    rateLimit: { burst: 1, perSec: 0.001 },
  });
  await createRoom();
  const { c, errors } = client();
  await until(() => c.state === "live");
  await c.put("AAAA");
  await c.put("BBBB");
  await until(() => errors.length === 1);
  await c.put("CCCC");
  await until(() => errors.length === 2);
  expect(errors).toEqual(["rate_limited", "rate_limited"]);
  expect(c.state).toBe("live");
});

test("room_full is reported, the client backs off, and connects once a slot frees", async () => {
  await relay.close();
  relay = await startRelay({ port: 0, log: () => {}, maxMembers: 1 });
  await createRoom();
  const holder = await connectOnce({ url: relay.url, hello: hello() });
  const { c, errors } = client();
  await until(() => errors.includes("room_full"));
  holder.end();
  await until(() => c.state === "live");
});

test("connectOnce with since 0 waits for the head seq, even with a trimmed buffer", async () => {
  await relay.close();
  relay = await startRelay({ port: 0, log: () => {}, bufferSize: 2 });
  await createRoom();
  const empty = await connectOnce({
    url: relay.url,
    hello: hello({ since: 0 }),
  });
  expect(empty.msgs).toEqual([]);
  empty.end();
  for (let i = 0; i < 5; i++) relay.inject(ROOM, "AAAA");
  const s = await connectOnce({ url: relay.url, hello: hello({ since: 0 }) });
  expect(s.welcome.seq).toBe(5);
  expect(s.msgs.map((m) => m.seq)).toEqual([4, 5]);
  s.end();
});

test("connectOnce.put resolves with the echo seq, ignoring a peer's message", async () => {
  await createRoom();
  const s = await connectOnce({ url: relay.url, hello: hello() });
  relay.inject(ROOM, "PEER");
  expect(await s.put("MINE")).toBe(2);
  s.end();
});

test("connectOnce.put rejects with rate_limited", async () => {
  await relay.close();
  relay = await startRelay({
    port: 0,
    log: () => {},
    rateLimit: { burst: 1, perSec: 0.001 },
  });
  await createRoom();
  const s = await connectOnce({ url: relay.url, hello: hello() });
  await s.put("AAAA");
  await expect(s.put("BBBB")).rejects.toMatchObject({ code: "rate_limited" });
  s.end();
});

test("connectOnce close: resolves on closed; bad signature rejects", async () => {
  const kp = await generateCloseKeyPair();
  const other = await generateCloseKeyPair();
  await createRoom(kp.publicKey);
  const bad = await connectOnce({
    url: relay.url,
    hello: hello({ closeOnly: true }),
  });
  await expect(
    bad.close(await signClose(other.secretKey, ROOM, bad.welcome.nonce)),
  ).rejects.toMatchObject({ code: "bad_signature" });
  await closeRoom(kp.secretKey);
  expect(relay.snapshot(ROOM)).toBeUndefined();
});

test("connectOnce: unknown room rejects room_not_found; unreachable rejects", async () => {
  await expect(
    connectOnce({ url: relay.url, hello: hello() }),
  ).rejects.toBeInstanceOf(RelayError);
  await expect(
    connectOnce({ url: relay.url, hello: hello() }),
  ).rejects.toMatchObject({
    code: "room_not_found",
  });
  await expect(
    connectOnce({ url: "ws://127.0.0.1:1", hello: hello() }),
  ).rejects.toThrow("cannot reach relay");
});
