import { agentroomHome, readRoomFile, runStdio } from "@agentroom/mcp";
import { type CliContext, resolveRoomId } from "../context.js";
import { isInside } from "../hook/submit.js";

/**
 * The room to serve: a room bound to a project directory is served only to agents started inside
 * it, so a user-scope MCP entry does not open the room to every session on the machine.
 */
export function servedRoomId(
  flag: string | undefined,
  ctx: CliContext,
): string | undefined {
  const roomId = resolveRoomId(flag, ctx);
  if (roomId === undefined) return undefined;
  let projectDir: string | undefined;
  try {
    projectDir = readRoomFile(agentroomHome(ctx.env), roomId).projectDir;
  } catch {
    return roomId; // runStdio reports the missing room itself.
  }
  return projectDir === undefined || isInside(projectDir, ctx.cwd)
    ? roomId
    : undefined;
}

/**
 * Serve `--room`, else the current room, else the no-room stub (KTD4). Writes nothing to stdout
 * itself; stdout is the MCP channel.
 */
export async function mcp(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  await runStdio({ roomId: servedRoomId(values.room, ctx), env: ctx.env });
  return 0;
}
