import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Envelope } from "@agentroom/protocol";
import { roomDir } from "./paths.js";
import { writeAtomic } from "./state.js";

/** First 12 hex characters of sha256 over the stored envelope JSON (KTD16). */
export function draftHash(env: Envelope): string {
  return createHash("sha256")
    .update(JSON.stringify(env))
    .digest("hex")
    .slice(0, 12);
}

/** Write the single draft slot `<room>/pending.json` (0600, atomic); a new draft replaces the old. */
export function writePending(
  home: string,
  roomId: string,
  env: Envelope,
): string {
  const hash = draftHash(env);
  writeAtomic(
    join(roomDir(home, roomId), "pending.json"),
    `${JSON.stringify({ v: 1, hash, createdAt: Date.now(), env })}\n`,
  );
  return hash;
}
