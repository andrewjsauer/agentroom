import { z } from "zod";

/** Room settings, sealed with the room key and stored opaquely by the relay. */
export const RoomMeta = z.object({
  name: z.string().optional(),
  maxAgentChain: z.number().int().positive().default(3),
});
export type RoomMeta = z.infer<typeof RoomMeta>;
