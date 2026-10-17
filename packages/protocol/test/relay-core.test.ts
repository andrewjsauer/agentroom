import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { generateCloseKeyPair, signClose, verifyClose } from "../src/index.js";
import {
  admitPut,
  DEFAULT_LIMITS,
  decideHello,
  decodedLength,
  expiresAt,
  newNonce,
  newRoomState,
  positiveInt,
  type RoomState,
  rateFor,
  verifyCloseWebCrypto,
} from "../src/relay-core.js";
import { type HelloFrame, roomUrl } from "../src/wire.js";

const ROOM = "a".repeat(64);
const L = DEFAULT_LIMITS;
const create = { closeKey: "k", meta: "m" };
const hello = (h: Partial<HelloFrame> = {}): HelloFrame => ({
  t: "hello",
  room: ROOM,
  proto: 1,
  ...h,
});
const live: RoomState = newRoomState(ROOM, create, 0, L);
const ctx = (c: Partial<Parameters<typeof decideHello>[1]> = {}) => ({
  room: undefined,
  tombstoned: false,
  members: 0,
  ipConns: 0,
  now: 1000,
  limits: L,
  ...c,
});

describe("decideHello", () => {
  test("create makes a room; join without one is room_not_found", () => {
    const d = decideHello(hello({ create }), ctx());
    expect(d.ok && d.created?.roomId).toBe(ROOM);
    expect(decideHello(hello(), ctx())).toMatchObject({
      code: "room_not_found",
    });
  });
  test("room_exists, tombstone, room_full", () => {
    expect(decideHello(hello({ create }), ctx({ room: live }))).toMatchObject({
      code: "room_exists",
    });
    expect(
      decideHello(hello({ create }), ctx({ tombstoned: true })),
    ).toMatchObject({
      code: "room_expired",
    });
    expect(decideHello(hello(), ctx({ room: live, members: 8 }))).toMatchObject(
      {
        code: "room_full",
      },
    );
  });
  test("closers are admitted at the member cap; only the per-address cap bounds them", () => {
    expect(
      decideHello(
        hello({ closeOnly: true }),
        ctx({ room: live, members: 8, ipConns: 9 }),
      ),
    ).toEqual({ ok: true, created: undefined, closeOnly: true });
    for (const h of [hello({ closeOnly: true }), hello()]) {
      expect(
        decideHello(h, ctx({ room: live, ipConns: L.maxRoomConnsPerIp })),
      ).toMatchObject({ code: "room_full" });
    }
  });
  test("closeOnly with create or since is bad_proto", () => {
    expect(
      decideHello(hello({ closeOnly: true, create }), ctx()),
    ).toMatchObject({
      code: "bad_proto",
    });
    expect(
      decideHello(hello({ closeOnly: true, since: 0 }), ctx({ room: live })),
    ).toMatchObject({ code: "bad_proto" });
  });
});

test("TTLs are capped and expiresAt takes the earlier deadline", () => {
  const s = newRoomState(
    ROOM,
    { ...create, idleTtlSec: 1e9, maxAgeSec: 1e9 },
    0,
    L,
  );
  expect(s.idleTtlSec).toBe(L.idleTtlSec);
  expect(s.maxAgeSec).toBe(L.maxAgeSec);
  expect(expiresAt(s)).toBe(L.idleTtlSec * 1000);
  const short = newRoomState(ROOM, { ...create, maxAgeSec: 60 }, 0, L);
  expect(expiresAt(short)).toBe(60_000);
});

test("admitPut refills tokens, rate-limits, and accepts exactly 64 KiB", () => {
  const rate = { tokens: 1, refilledAt: 0 };
  const ok = btoa("x".repeat(65_536));
  expect(admitPut(rate, ok, 0, L)).toEqual({ ok: true });
  expect(admitPut(rate, ok, 0, L)).toMatchObject({ code: "rate_limited" });
  expect(admitPut(rate, ok, 500, L)).toEqual({ ok: true });
  expect(
    admitPut({ tokens: 5, refilledAt: 0 }, btoa("x".repeat(65_537)), 0, L),
  ).toMatchObject({
    code: "too_large",
  });
});

test("decodedLength matches Buffer.byteLength for 0, 1 and 2 padding characters", () => {
  for (const s of ["", "a", "ab", "abc", "abcd", "abcde", "x".repeat(1000)]) {
    const b64 = Buffer.from(s).toString("base64");
    expect(decodedLength(b64)).toBe(Buffer.byteLength(b64, "base64"));
  }
  expect(decodedLength("not base64!")).toBe(
    Buffer.byteLength("not base64!", "base64"),
  );
});

test("nonces are 16 random bytes", () => {
  const a = newNonce();
  expect(Buffer.from(a, "base64")).toHaveLength(16);
  expect(new Set(Array.from({ length: 50 }, newNonce)).size).toBe(50);
});

test("roomUrl sets ?room= and keeps paths", () => {
  expect(roomUrl("wss://r.example/relay", ROOM)).toBe(
    `wss://r.example/relay?room=${ROOM}`,
  );
  expect(roomUrl("ws://127.0.0.1:1", ROOM)).toBe(
    `ws://127.0.0.1:1/?room=${ROOM}`,
  );
});

test("relay-core imports no Node API, Buffer or libsodium", () => {
  for (const f of ["relay-core.ts", "wire.ts"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/from\s+"node:|\bBuffer\b|libsodium/);
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
      expect(["zod", "./wire.js"]).toContain(m[1]);
    }
  }
});

test("KTD7: Web Crypto and libsodium agree on valid, tampered, wrong-key, replayed and malformed cases", async () => {
  const kp = await generateCloseKeyPair();
  const other = await generateCloseKeyPair();
  const nonce = newNonce();
  const sig = await signClose(kp.secretKey, ROOM, nonce);
  const flipped = Buffer.from(sig, "base64");
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  const cases: [string, string, string, string, boolean][] = [
    [kp.publicKey, sig, ROOM, nonce, true],
    [kp.publicKey, flipped.toString("base64"), ROOM, nonce, false],
    [other.publicKey, sig, ROOM, nonce, false],
    [kp.publicKey, sig, ROOM, newNonce(), false],
    [kp.publicKey, sig, "b".repeat(64), nonce, false],
    [kp.publicKey, "not*base64", ROOM, nonce, false],
    ["@@", sig, ROOM, nonce, false],
    [kp.publicKey, sig.slice(4), ROOM, nonce, false],
  ];
  for (const [pk, s, room, n, want] of cases) {
    expect(await verifyClose(pk, s, room, n)).toBe(want);
    expect(await verifyCloseWebCrypto(pk, s, room, n)).toBe(want);
  }
});

test("positiveInt accepts positive integers, treats unset as default, and throws on the rest", () => {
  expect(positiveInt("X", undefined)).toBeUndefined();
  expect(positiveInt("X", "")).toBeUndefined();
  expect(positiveInt("X", "1")).toBe(1);
  expect(positiveInt("X", "86400")).toBe(86_400);
  for (const bad of [
    "0",
    "-1",
    "1.5",
    "2e3",
    " 5",
    "0x10",
    "abc",
    "Infinity",
    "99999999999999999999",
  ]) {
    expect(() => positiveInt("BUFFER_SIZE", bad)).toThrow(
      `BUFFER_SIZE must be a positive integer, got "${bad}"`,
    );
  }
});

test("rateFor shares one bucket per key and starts it full", () => {
  const rates = new Map();
  const a = rateFor(rates, "1.2.3.4", 0, L);
  expect(a).toEqual({ tokens: L.rateBurst, refilledAt: 0 });
  a.tokens = 0;
  expect(rateFor(rates, "1.2.3.4", 5, L)).toBe(a);
  expect(rateFor(rates, "5.6.7.8", 5, L).tokens).toBe(L.rateBurst);
});
