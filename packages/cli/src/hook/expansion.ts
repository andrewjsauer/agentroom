import { agentroomHome } from "@agentroom/mcp";
import {
  chainState,
  type Envelope,
  ulid,
  waitingThreads,
} from "@agentroom/protocol";
import { z } from "zod";
import { sayTarget } from "../commands/say.js";
import { setDeliveryMode } from "../commands/sync-mode.js";
import { type CliContext, loadRoom } from "../context.js";
import { humanFrom } from "../human.js";
import { connectForPost, type PostSession } from "../room-post.js";
import { id8, safeLine, stripTerminal } from "../safe-text.js";
import { previewDraft, releaseDraft } from "./release.js";
import { readHookInput } from "./stdin.js";

const ExpansionInput = z.looseObject({
  hook_event_name: z.string(),
  expansion_type: z.string(),
  command_name: z.string(),
  command_args: z.string().default(""),
  prompt: z.string().default(""),
});

const COMMANDS = ["say", "approve", "send", "sync-mode"] as const;
type Command = (typeof COMMANDS)[number];

const GUARD_TEXT = "agentroom hook: not running as a Claude Code plugin hook";

/**
 * Which human-only command this is, if any (KTD8). `agentroom:<name>` always; a bare name only
 * when the typed prompt starts with `/agentroom:<name>`, so a user's own `/approve` expands.
 */
export function recognize(
  commandName: string,
  prompt: string,
): Command | undefined {
  const bare = commandName.startsWith("agentroom:")
    ? commandName.slice("agentroom:".length)
    : commandName;
  const known = (COMMANDS as readonly string[]).includes(bare);
  if (!known) return undefined;
  if (bare !== commandName) return bare as Command;
  return new RegExp(`^/agentroom:${bare}(\\s|$)`).test(prompt.trimStart())
    ? (bare as Command)
    : undefined;
}

class Usage extends Error {}

/** `[--thread <id> | --new] <text>`; the text keeps its internal newlines (KTD8). */
function parseSayArgs(args: string): {
  thread?: string;
  isNew: boolean;
  body: string;
} {
  let rest = args.trim();
  let thread: string | undefined;
  let isNew = false;
  for (;;) {
    const t = /^--thread\s+(\S+)(\s+|$)/.exec(rest);
    if (t) {
      if (thread !== undefined) throw new Usage("--thread given twice");
      thread = t[1] as string;
      rest = rest.slice(t[0].length);
      continue;
    }
    const n = /^--new(\s+|$)/.exec(rest);
    if (n) {
      isNew = true;
      rest = rest.slice(n[0].length);
      continue;
    }
    break;
  }
  if (thread !== undefined && isNew) {
    throw new Usage("use either --thread or --new, not both");
  }
  if (rest === "") throw new Usage("say needs a message");
  return { thread, isNew, body: rest };
}

async function say(args: string, ctx: CliContext): Promise<string> {
  let parsed: ReturnType<typeof parseSayArgs>;
  try {
    parsed = parseSayArgs(args);
  } catch (err) {
    if (!(err instanceof Usage)) throw err;
    return `Not sent: ${err.message}. Usage: /agentroom:say [--thread <id> | --new] <text>`;
  }
  const s = await connectForPost(undefined, ctx);
  try {
    const id = ulid();
    const { thread, replyTo } = sayTarget(s.history, id, parsed);
    await s.post({
      v: 1,
      id,
      ts: Date.now(),
      from: humanFrom(s.room, "hook"),
      kind: replyTo === undefined ? "question" : "answer",
      thread,
      replyTo,
      body: parsed.body,
    });
    const where = replyTo === undefined ? "new thread" : "thread";
    return `Sent to room ${s.room.roomId.slice(0, 8)} as ${safeLine(s.room.member)} (human) in ${where} ${id8(thread)}.`;
  } finally {
    s.end();
  }
}

/** The most recently updated thread at the chain limit (KTD9). */
function latestWaiting(s: PostSession): string | undefined {
  const { history } = s;
  const waiting = new Set(
    waitingThreads(chainState(history, s.maxAgentChain, s.localIds)).map(
      (w) => w.thread,
    ),
  );
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i] as Envelope;
    if (waiting.has(e.thread)) return e.thread;
  }
  return undefined;
}

async function approve(args: string, ctx: CliContext): Promise<string> {
  const requested = args.trim();
  if (/\s/.test(requested)) {
    return "Not sent: usage: /agentroom:approve [thread]";
  }
  const s = await connectForPost(undefined, ctx);
  try {
    const id = ulid();
    let thread: string | undefined;
    if (requested === "") {
      thread = latestWaiting(s);
      if (thread === undefined) {
        return "Not sent: no thread is waiting on a human; pass a thread id.";
      }
    } else {
      thread = sayTarget(s.history, id, {
        thread: requested,
        isNew: false,
      }).thread;
    }
    await s.post({
      v: 1,
      id,
      ts: Date.now(),
      from: humanFrom(s.room, "hook"),
      kind: "approve",
      thread,
      body: "",
    });
    return `Approved thread ${id8(thread)} in room ${s.room.roomId.slice(0, 8)} as ${safeLine(s.room.member)} (human).`;
  } finally {
    s.end();
  }
}

async function run(
  command: Command,
  args: string,
  ctx: CliContext,
): Promise<string> {
  switch (command) {
    case "say":
      return say(args, ctx);
    case "approve":
      return approve(args, ctx);
    case "send":
      return args.trim() === ""
        ? previewDraft(ctx)
        : releaseDraft(args.trim(), ctx);
    case "sync-mode": {
      const { roomId } = loadRoom(undefined, ctx);
      const mode = args.trim();
      return setDeliveryMode(
        agentroomHome(ctx.env),
        roomId,
        mode === "" ? undefined : mode,
      );
    }
  }
}

/**
 * `agentroom hook prompt-expansion` (KTD6-KTD8). For a recognized human-only command it always
 * prints one `{"decision":"block"}` object and exits 0, so the typed text never reaches the
 * model; anything else prints nothing. Refuses outside a plugin hook and posts nothing.
 */
export async function promptExpansion(ctx: CliContext): Promise<number> {
  if (!ctx.env.CLAUDE_PLUGIN_ROOT || ctx.isTTY) {
    ctx.stderr.write(`${GUARD_TEXT}\n`);
    return 1;
  }
  let input: z.output<typeof ExpansionInput>;
  try {
    input = await readHookInput(ctx, ExpansionInput);
  } catch (err) {
    ctx.stderr.write(
      `${GUARD_TEXT}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (
    input.hook_event_name !== "UserPromptExpansion" ||
    input.expansion_type !== "slash_command"
  ) {
    ctx.stderr.write(`${GUARD_TEXT}\n`);
    return 1;
  }
  const command = recognize(input.command_name, input.prompt);
  if (command === undefined) return 0;
  let reason: string;
  try {
    reason = await run(command, input.command_args, ctx);
  } catch (err) {
    reason = `Not sent: ${stripTerminal(err instanceof Error ? err.message : String(err))}`;
  }
  ctx.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  return 0;
}
