import { z } from "zod";

/** Relay wire protocol version, sent as `proto` in the `hello` frame. */
export const PROTOCOL_VERSION = 1;

export const RoomId = z.string().regex(/^[0-9a-f]{64}$/);

const Seq = z.number().int().nonnegative();

export const HelloFrame = z.object({
  t: z.literal("hello"),
  room: RoomId,
  proto: z.literal(PROTOCOL_VERSION),
  since: Seq.optional(),
  /** Admitted past the connection cap; may send only `close` (KTD8). */
  closeOnly: z.literal(true).optional(),
  create: z
    .object({
      closeKey: z.string(),
      idleTtlSec: z.number().int().positive().optional(),
      maxAgeSec: z.number().int().positive().optional(),
      meta: z.string(),
    })
    .optional(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

/** Frames a client sends to the relay. */
export const ClientFrame = z.discriminatedUnion("t", [
  HelloFrame,
  z.object({ t: z.literal("put"), blob: z.string() }),
  z.object({ t: z.literal("close"), sig: z.string() }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * Keepalive frames, byte for byte: relay-cf answers PING_FRAME with PONG_FRAME through a
 * Durable Object auto-response, which matches the exact text.
 */
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';

export const ErrorCode = z.enum([
  "room_not_found",
  "room_expired",
  "room_exists",
  "bad_signature",
  "too_large",
  "rate_limited",
  "room_full",
  "bad_proto",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const WelcomeFrame = z.object({
  t: z.literal("welcome"),
  seq: Seq,
  members: z.number().int().nonnegative(),
  /** Bounded so every client can format it as a date. */
  expiresAt: z.number().int().min(0).max(8.64e15),
  nonce: z.string(),
  meta: z.string(),
  /**
   * Keepalive request: send PING_FRAME at least this often (ms). Relays without it accept no
   * `ping`, so clients ping only when it is present.
   */
  ping: z.number().int().positive().optional(),
});
export type WelcomeFrame = z.infer<typeof WelcomeFrame>;

export const ErrorFrame = z.object({
  t: z.literal("error"),
  code: ErrorCode,
  message: z.string(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

/** Frames the relay sends to a client. */
export const RelayFrame = z.discriminatedUnion("t", [
  WelcomeFrame,
  z.object({ t: z.literal("msg"), seq: Seq, blob: z.string() }),
  z.object({
    t: z.literal("presence"),
    members: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal("closed") }),
  z.object({ t: z.literal("pong") }),
  ErrorFrame,
]);
export type RelayFrame = z.infer<typeof RelayFrame>;

/**
 * The relay URL with `?room=<room_id>` set (M4 KTD8): a Cloudflare relay picks the room's
 * Durable Object at upgrade time, before `hello`. relay-node ignores the query.
 */
export function roomUrl(relay: string, roomId: string): string {
  const url = new URL(relay);
  url.searchParams.set("room", roomId);
  return url.toString();
}
