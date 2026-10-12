import type { RoomFile } from "@agentroom/mcp";
import { type CliContext, CliError } from "./context.js";

/**
 * Environment variables that agent shells set (KTD18; sources and dates in
 * docs/OPEN_QUESTIONS.md). Any non-empty value refuses a human-only command.
 */
export const AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "GEMINI_CLI",
  "CURSOR_AGENT",
] as const;

/**
 * Refuse unless a person is at the terminal: agent markers first (so the refusal names the
 * real cause), then TTYs. A guard against accidental impersonation, not a security boundary.
 */
export function requireHumanTerminal(
  ctx: CliContext,
  opts: { stdout: boolean; reason: string },
): void {
  for (const name of AGENT_MARKERS) {
    if (ctx.env[name]) {
      throw new CliError(
        `Refusing: ${name} is set, so this looks like an AI agent's shell. ${opts.reason}`,
      );
    }
  }
  if (!ctx.isTTY || (opts.stdout && !ctx.stdoutIsTTY)) {
    const streams = opts.stdout ? "stdin and stdout" : "stdin";
    throw new CliError(
      `Refusing: this command needs an interactive terminal (${streams} must be a TTY). ${opts.reason}`,
    );
  }
}

export const HUMAN_MESSAGE_REASON =
  "Human messages must come from your own terminal.";

/** The only human-tagged `from` outside tests (KTD21); used by `say` and `approve` alone. */
export function humanFrom(room: RoomFile): {
  member: string;
  agent: "human";
  via: "cli";
} {
  return { member: room.member, agent: "human", via: "cli" };
}
