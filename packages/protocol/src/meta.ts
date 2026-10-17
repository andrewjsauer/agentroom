import { z } from "zod";

/** The highest per-thread agent chain limit a room may set. */
export const MAX_AGENT_CHAIN = 10;

/** Room settings, sealed with the room key and stored opaquely by the relay. */
export const RoomMeta = z.object({
  name: z.string().optional(),
  maxAgentChain: z.number().int().min(1).max(MAX_AGENT_CHAIN).default(3),
});
export type RoomMeta = z.infer<typeof RoomMeta>;

/**
 * Room settings as read from the relay. Rooms created before the cap could carry any positive
 * limit; it is clamped to `MAX_AGENT_CHAIN`, and `clampedFrom` keeps the value the room asked for.
 */
export const OpenedRoomMeta = z
  .object({
    name: z.string().optional(),
    maxAgentChain: z.number().int().positive().default(3),
  })
  .transform((m) =>
    m.maxAgentChain > MAX_AGENT_CHAIN
      ? { ...m, maxAgentChain: MAX_AGENT_CHAIN, clampedFrom: m.maxAgentChain }
      : { ...m, clampedFrom: undefined as number | undefined },
  );
export type OpenedRoomMeta = z.infer<typeof OpenedRoomMeta>;
