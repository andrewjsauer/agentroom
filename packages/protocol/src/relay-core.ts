/**
 * Room rules shared by relay-node and relay-cf (M4 KTD6). Web platform globals only: no Node
 * APIs, no Buffer, no libsodium, so the Worker bundle stays free of node:crypto and WebAssembly.
 */
import { ClientFrame, type ErrorCode, type HelloFrame } from "./wire.js";

export interface RelayLimits {
  /** Ceiling for a room's idle TTL. */
  idleTtlSec: number;
  /** Default and ceiling for a room's max age. */
  maxAgeSec: number;
  bufferSize: number;
  maxEnvelopeBytes: number;
  /** Connections per room, close-only connections excepted. */
  maxMembers: number;
  /** Close-only connections held per room; a new one evicts the oldest. */
  maxClosers: number;
  /** Token bucket on `put`, per connection. */
  rateBurst: number;
  ratePerSec: number;
  /** How long a close-only connection may wait before sending `close`. */
  closeGraceMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  idleTtlSec: 28_800,
  maxAgeSec: 86_400,
  bufferSize: 500,
  maxEnvelopeBytes: 65_536,
  maxMembers: 8,
  maxClosers: 2,
  rateBurst: 20,
  ratePerSec: 2,
  closeGraceMs: 10_000,
};

/** Largest WebSocket frame a relay accepts. */
export const MAX_FRAME_BYTES = 96 * 1024;

/** Structured relay event. Never carries a blob or meta (invariant 1). */
export type RelayEvent =
  | { event: "room_created"; room: string }
  | { event: "room_expired"; room: string }
  | { event: "room_closed"; room: string }
  | { event: "conn_open"; room: string; members: number }
  | { event: "closer_open"; room: string }
  | { event: "conn_close"; room: string; members: number }
  | { event: "error"; code: ErrorCode };

/** A room's state apart from its envelope buffer. */
export interface RoomState {
  roomId: string;
  seq: number;
  meta: string;
  closeKey: string;
  idleTtlSec: number;
  maxAgeSec: number;
  createdAt: number;
  lastActivity: number;
}

export interface Refusal {
  ok: false;
  code: ErrorCode;
  message: string;
}

/** Parse a text frame; undefined when it is not a valid client frame. */
export function parseClientFrame(data: string): ClientFrame | undefined {
  try {
    return ClientFrame.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export type HelloDecision =
  | Refusal
  | {
      ok: true;
      /** Set when this hello creates the room. */
      created?: RoomState;
      closeOnly: boolean;
      /** A close-only hello at the closer cap evicts the oldest closer. */
      evictCloser: boolean;
    };

/**
 * Decide a `hello` against the room's live state (undefined when absent or expired), whether
 * its id is tombstoned, and the current connection counts.
 */
export function decideHello(
  hello: HelloFrame,
  ctx: {
    room: RoomState | undefined;
    tombstoned: boolean;
    members: number;
    closers: number;
    now: number;
    limits: RelayLimits;
  },
): HelloDecision {
  const refuse = (code: ErrorCode, message: string): Refusal => ({
    ok: false,
    code,
    message,
  });
  if (hello.closeOnly && (hello.create || hello.since !== undefined)) {
    return refuse(
      "bad_proto",
      "closeOnly cannot be combined with create or since",
    );
  }
  if (!ctx.room && ctx.tombstoned) {
    return refuse("room_expired", "room was closed or expired");
  }
  let created: RoomState | undefined;
  if (hello.create) {
    if (ctx.room)
      return refuse("room_exists", "a live room already has this id");
    created = newRoomState(hello.room, hello.create, ctx.now, ctx.limits);
  } else if (!ctx.room) {
    return refuse(
      "room_not_found",
      "room not found: it expired, was closed, or the relay restarted",
    );
  }
  const closeOnly = hello.closeOnly === true;
  const members = created ? 0 : ctx.members;
  if (!closeOnly && members >= ctx.limits.maxMembers) {
    return refuse("room_full", "room is at its connection cap");
  }
  return {
    ok: true,
    created,
    closeOnly,
    evictCloser: closeOnly && !created && ctx.closers >= ctx.limits.maxClosers,
  };
}

/** A new room's state, with its TTLs capped by the relay limits. */
export function newRoomState(
  roomId: string,
  create: NonNullable<HelloFrame["create"]>,
  now: number,
  limits: RelayLimits,
): RoomState {
  return {
    roomId,
    seq: 0,
    meta: create.meta,
    closeKey: create.closeKey,
    idleTtlSec: Math.min(
      create.idleTtlSec ?? limits.idleTtlSec,
      limits.idleTtlSec,
    ),
    maxAgeSec: Math.min(create.maxAgeSec ?? limits.maxAgeSec, limits.maxAgeSec),
    createdAt: now,
    lastActivity: now,
  };
}

/** When the room ends: the earlier of its idle deadline and its max age. */
export function expiresAt(state: RoomState): number {
  return Math.min(
    state.lastActivity + state.idleTtlSec * 1000,
    state.createdAt + state.maxAgeSec * 1000,
  );
}

/** Until when a closed or expired id is refused: its original max age. */
export function tombstoneUntil(state: RoomState): number {
  return state.createdAt + state.maxAgeSec * 1000;
}

/** Decoded byte length of a base64 string, as Node's `Buffer.byteLength(s, "base64")` counts it. */
export function decodedLength(b64: string): number {
  let bytes = b64.length;
  if (b64.charCodeAt(bytes - 1) === 0x3d) bytes--;
  if (bytes > 1 && b64.charCodeAt(bytes - 1) === 0x3d) bytes--;
  return (bytes * 3) >>> 2;
}

export interface RateState {
  tokens: number;
  refilledAt: number;
}

/** Refill and spend one token, then check the envelope size. Mutates `rate`. */
export function admitPut(
  rate: RateState,
  blob: string,
  now: number,
  limits: RelayLimits,
): Refusal | { ok: true } {
  rate.tokens = Math.min(
    limits.rateBurst,
    rate.tokens + ((now - rate.refilledAt) / 1000) * limits.ratePerSec,
  );
  rate.refilledAt = now;
  if (rate.tokens < 1) {
    return {
      ok: false,
      code: "rate_limited",
      message: "too many messages; slow down",
    };
  }
  rate.tokens -= 1;
  if (decodedLength(blob) > limits.maxEnvelopeBytes) {
    return { ok: false, code: "too_large", message: "envelope exceeds 64 KiB" };
  }
  return { ok: true };
}

/** Advance the room for an accepted `put`; returns the new seq. */
export function applyPut(state: RoomState, now: number): number {
  state.seq += 1;
  state.lastActivity = now;
  return state.seq;
}

const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A fresh 16-byte welcome nonce, base64. */
export function newNonce(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

const STRICT_B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Verify a `close` signature with Web Crypto Ed25519 (M4 KTD7): the same message and checks as
 * protocol's libsodium `verifyClose`, for runtimes that cannot compile libsodium's WebAssembly.
 */
export async function verifyCloseWebCrypto(
  publicKey: string,
  sig: string,
  roomId: string,
  nonce: string,
): Promise<boolean> {
  if (!STRICT_B64.test(publicKey) || !STRICT_B64.test(sig)) return false;
  const pk = b64ToBytes(publicKey);
  const sg = b64ToBytes(sig);
  const n = b64ToBytes(nonce);
  if (pk?.length !== 32 || sg?.length !== 64 || !n) return false;
  const id = new TextEncoder().encode(roomId);
  const message = new Uint8Array(id.length + n.length);
  message.set(id);
  message.set(n, id.length);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sg, message);
  } catch {
    return false;
  }
}
