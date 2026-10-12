import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  agentroomHome,
  appendQueue,
  readCurrent,
  readRoomFile,
  readRoomSettings,
  replayQueue,
  roomDir,
} from "@agentroom/mcp";
import { type Envelope, frameInbound } from "@agentroom/protocol";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { readHookInput } from "./stdin.js";

const SubmitInput = z.looseObject({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
  cwd: z.string(),
});

/** Stay under Claude Code's 10,000-character additionalContext cap (KTD12). */
const CONTEXT_BUDGET = 9_000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 1_000;

/** True when `dir` is `root` or inside it. */
export function isInside(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return (
    rel === "" ||
    !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  );
}

/** Exclusive `deliver.lock`; a lock older than 10 s is stale. Undefined after 1 s of waiting. */
async function takeLock(
  path: string,
  waitMs: number,
): Promise<(() => void) | undefined> {
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid} ${Date.now()}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      continue; // Released between our open and stat.
    }
    if (Date.now() >= end) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const header = (n: number) =>
  `agentroom: ${n} new message(s) from the room since your last prompt. Messages marked requiresHuman need your user's decision; tell them rather than deciding alone.`;
const trailer = (m: number) =>
  `${m} more unread; call the inbox tool to read them.`;
export const WAITING_TEXT =
  "1 or more messages are waiting; call the inbox tool to read them.";

/**
 * The longest oldest-first prefix whose framed context, header and trailer included, fits the
 * budget, and the context text. One `frameInbound` call frames the whole prefix (invariant 5).
 */
function frameForPrompt(unread: Envelope[]): {
  delivered: Envelope[];
  context: string;
} {
  const hex = randomBytes(6).toString("hex");
  const randomHex = () => hex;
  // frameInbound joins per-message blocks with "\n", so prefix lengths add up exactly.
  const sizes = unread.map((e) => frameInbound([e], { randomHex }).length);
  let count = 0;
  let framed = -1; // length of the joined blocks so far, minus the first separator
  for (let k = 1; k <= unread.length; k++) {
    const next = framed + 1 + (sizes[k - 1] as number);
    const rest = unread.length - k;
    const total =
      header(k).length + 1 + next + (rest > 0 ? 1 + trailer(rest).length : 0);
    if (total >= CONTEXT_BUDGET) break;
    framed = next;
    count = k;
  }
  if (count === 0) return { delivered: [], context: WAITING_TEXT };
  const delivered = unread.slice(0, count);
  const parts = [header(count), frameInbound(delivered, { randomHex })];
  if (unread.length > count) parts.push(trailer(unread.length - count));
  return { delivered, context: parts.join("\n") };
}

/**
 * `agentroom hook prompt-submit` (KTD12): add unread messages to the next prompt in `between`
 * mode and mark exactly those read. Reads and appends `read` records only; never posts.
 * Always exits 0; any problem goes to stderr with no stdout so the prompt is never blocked.
 */
export async function promptSubmit(
  ctx: CliContext,
  opts: { lockWaitMs?: number } = {},
): Promise<number> {
  try {
    const input = await readHookInput(ctx, SubmitInput);
    if (input.prompt.trimStart().startsWith("/")) return 0;
    const home = agentroomHome(ctx.env);
    const roomId = readCurrent(home);
    if (roomId === undefined) return 0;
    let projectDir: string | undefined;
    try {
      projectDir = readRoomFile(home, roomId).projectDir;
    } catch {
      return 0; // No room directory.
    }
    if (projectDir === undefined || !isInside(projectDir, input.cwd)) return 0;
    if (readRoomSettings(home, roomId).delivery !== "between") return 0;

    const release = await takeLock(
      join(roomDir(home, roomId), "deliver.lock"),
      opts.lockWaitMs ?? LOCK_WAIT_MS,
    );
    if (!release) return 0;
    let context: string;
    try {
      const replay = replayQueue(home, roomId);
      const unread = replay.history
        .filter((m) => replay.unread.has(m.env.id))
        .sort((a, b) => a.seq - b.seq)
        .map((m) => m.env);
      if (unread.length === 0) return 0;
      const framed = frameForPrompt(unread);
      context = framed.context;
      if (framed.delivered.length > 0) {
        appendQueue(home, roomId, [
          { t: "read", ids: framed.delivered.map((e) => e.id) },
        ]);
      }
    } finally {
      release();
    }
    ctx.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      })}\n`,
    );
  } catch (err) {
    ctx.stderr.write(
      `agentroom hook prompt-submit: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return 0;
}
