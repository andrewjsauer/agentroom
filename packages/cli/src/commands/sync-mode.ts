import {
  agentroomHome,
  readRoomSettings,
  writeRoomSettings,
} from "@agentroom/mcp";
import { type CliContext, CliError, loadRoom } from "../context.js";

/**
 * Show or set a room's delivery mode and return the text to print (KTD11). Shared by
 * `agentroom sync-mode` and `/agentroom:sync-mode`. `live` is refused and changes nothing.
 */
export function setDeliveryMode(
  home: string,
  roomId: string,
  arg: string | undefined,
): string {
  const current = readRoomSettings(home, roomId).delivery;
  const head = `Delivery mode for room ${roomId.slice(0, 8)}:`;
  if (arg === undefined) return `${head} ${current}.`;
  if (arg === "live") {
    return `Live delivery is not available yet: Claude Code channels are a research preview that does not load this server. Mode unchanged (${current}).`;
  }
  if (arg !== "between" && arg !== "manual") {
    throw new CliError(
      `unknown delivery mode "${arg}"; use between or manual`,
      2,
    );
  }
  writeRoomSettings(home, roomId, { v: 1, delivery: arg });
  return `${head} ${arg}.`;
}

/** `agentroom sync-mode [between|manual|live] [--room <id>]`. No TTY guard: not a human-tag path. */
export function syncMode(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): number {
  if (positionals.length > 1) {
    throw new CliError("sync-mode takes at most one mode", 2);
  }
  const { roomId } = loadRoom(values.room, ctx);
  ctx.stdout.write(
    `${setDeliveryMode(agentroomHome(ctx.env), roomId, positionals[0])}\n`,
  );
  return 0;
}
