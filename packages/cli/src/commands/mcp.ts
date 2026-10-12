import { runStdio } from "@agentroom/mcp";
import { type CliContext, CliError, resolveRoomId } from "../context.js";

/** Serve the room over stdio. Writes nothing to stdout itself; stdout is the MCP channel. */
export async function mcp(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const roomId = resolveRoomId(values.room, ctx);
  if (roomId === undefined) {
    throw new CliError("no current room; pass --room <id>", 2);
  }
  await runStdio({ roomId, env: ctx.env });
  return 0;
}
