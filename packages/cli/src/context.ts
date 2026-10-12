import { type AgentName, agentroomHome, readCurrent } from "@agentroom/mcp";
import { RoomId } from "@agentroom/protocol";

/** Everything a command touches in the process, injected so tests never hit the real environment. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
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
