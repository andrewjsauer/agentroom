import {
  type AgentName,
  agentroomHome,
  clearCurrentIf,
  deleteRoomDir,
  RelayError,
  type RoomFile,
  readCurrent,
  readRoomFile,
} from "@agentroom/mcp";
import { RoomId } from "@agentroom/protocol";

/** Everything a command touches in the process, injected so tests never hit the real environment. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  stdoutIsTTY: boolean;
  /** Absolute path of the running entry file (dist/bin.js). */
  entryPath: string;
}

/** Thrown by commands to end with a message and an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

const AGENT_FLAGS: Record<string, AgentName> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
};

/** Map the --agent flag to the room.json enum; anything outside it is a usage error. */
export function parseAgent(flag: string | undefined): AgentName {
  if (flag === undefined) return "other";
  const agent = AGENT_FLAGS[flag];
  if (!agent) {
    throw new CliError(
      `invalid --agent "${flag}"; use claude, codex, gemini or cursor`,
      2,
    );
  }
  return agent;
}

/** `--room <id>` when given, else the room named in `current`. */
export function resolveRoomId(
  flag: string | undefined,
  ctx: CliContext,
): string | undefined {
  if (flag !== undefined) {
    if (!RoomId.safeParse(flag).success) {
      throw new CliError("--room must be a 64-character hex room id", 2);
    }
    return flag;
  }
  return readCurrent(agentroomHome(ctx.env));
}

/** The resolved room and its room.json; a clear error when there is none. */
export function loadRoom(
  flag: string | undefined,
  ctx: CliContext,
): { roomId: string; room: RoomFile } {
  const roomId = resolveRoomId(flag, ctx);
  if (roomId !== undefined) {
    try {
      return { roomId, room: readRoomFile(agentroomHome(ctx.env), roomId) };
    } catch {
      // Fall through to the no-room error.
    }
  }
  throw new CliError(
    "No current room. Run `agentroom up` or `agentroom join <code>`.",
  );
}

/** The relay refused because the room expired, was closed, or was never there. */
export const isGone = (err: unknown): boolean =>
  err instanceof RelayError &&
  (err.code === "room_not_found" || err.code === "room_expired");

/** Delete local state for a room the relay no longer has and return the text to show. */
export function forgetGoneRoom(
  home: string,
  roomId: string,
  relay: string,
): string {
  deleteRoomDir(home, roomId);
  clearCurrentIf(home, roomId);
  return `Room ${roomId} has expired or no longer exists on ${relay} (it may have restarted); local state removed. Run \`agentroom up\` to start a new room.`;
}
