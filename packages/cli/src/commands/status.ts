import {
  agentroomHome,
  oneShot,
  type RoomFile,
  readRoomFile,
  readStatus,
} from "@agentroom/mcp";
import { type CliContext, forgetGoneRoom, resolveRoomId } from "../context.js";

export async function status(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const home = agentroomHome(ctx.env);
  const roomId = resolveRoomId(values.room, ctx);
  let room: RoomFile | undefined;
  if (roomId !== undefined) {
    try {
      room = readRoomFile(home, roomId);
    } catch {
      room = undefined;
    }
  }
  if (roomId === undefined || room === undefined) {
    ctx.stdout.write(
      "No current room. Run `agentroom up` or `agentroom join <code>`.\n",
    );
    return 1;
  }

  const res = await oneShot({
    url: room.relay,
    hello: { t: "hello", room: roomId, proto: 1 },
  });
  if (res.t === "error") {
    if (res.code === "room_not_found" || res.code === "room_expired") {
      ctx.stdout.write(`${forgetGoneRoom(home, roomId, room.relay)}\n`);
      return 1;
    }
    ctx.stderr.write(`relay error ${res.code}: ${res.message}\n`);
    return 1;
  }

  const lines = [
    `Room: ${roomId}`,
    `Member: ${room.member} (${room.agent})${room.createdByMe ? ", creator" : ""}`,
    `Relay: ${room.relay}`,
    `Connections: ${res.members}`,
    `Expires: ${new Date(res.expiresAt).toISOString()}`,
  ];
  const local = readStatus(home, roomId);
  if (local) {
    lines.push(
      `Unread: ${local.unread} (${local.needsYou} need you), connection ${local.connection}, as of ${new Date(local.updatedAt).toISOString()}`,
    );
  } else {
    lines.push("Unread: no local status yet (the MCP server has not run).");
  }
  ctx.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
