import {
  agentroomHome,
  clearCurrentIf,
  connectOnce,
  deleteRoomDir,
  type OnceSession,
  RelayError,
} from "@agentroom/mcp";
import { signClose } from "@agentroom/protocol";
import {
  type CliContext,
  CliError,
  forgetGoneRoom,
  isGone,
  loadRoom,
} from "../context.js";

export const CREATOR_ONLY_TEXT =
  "Only the machine that created this room can close it. Ask the creator to run `agentroom down`; this room's local state goes away when the room closes or expires.";

/** Close the room as its creator: sign the fresh nonce over a close-only connection (KTD22). */
export async function down(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const home = agentroomHome(ctx.env);
  const { roomId, room } = loadRoom(values.room, ctx);
  if (!room.createdByMe || !room.closeSecretKey) {
    throw new CliError(CREATOR_ONLY_TEXT);
  }
  let once: OnceSession;
  try {
    once = await connectOnce({
      url: room.relay,
      hello: { t: "hello", room: roomId, proto: 1, closeOnly: true },
    });
  } catch (err) {
    if (!isGone(err)) throw err;
    ctx.stdout.write(`${forgetGoneRoom(home, roomId, room.relay)}\n`);
    return 0;
  }
  try {
    await once.close(
      await signClose(room.closeSecretKey, roomId, once.welcome.nonce),
    );
  } catch (err) {
    if (err instanceof RelayError && err.code === "bad_signature") {
      throw new CliError(
        "The relay rejected the close signature (bad_signature); local state kept.",
      );
    }
    if (!isGone(err)) throw err;
  } finally {
    once.end();
  }
  deleteRoomDir(home, roomId);
  clearCurrentIf(home, roomId);
  ctx.stdout.write(`Room ${roomId} closed; local state removed.\n`);
  return 0;
}
