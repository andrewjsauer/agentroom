import { runStdio } from "@agentroom/mcp";
import { type CliContext, resolveRoomId } from "../context.js";

/**
 * Serve `--room`, else the current room, else the no-room stub (KTD4). Writes nothing to stdout
 * itself; stdout is the MCP channel.
 */
export async function mcp(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  await runStdio({ roomId: resolveRoomId(values.room, ctx), env: ctx.env });
  return 0;
}
