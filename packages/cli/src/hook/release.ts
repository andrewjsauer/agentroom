import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentroomHome, draftHash, roomDir, writeAtomic } from "@agentroom/mcp";
import { Envelope, ulid } from "@agentroom/protocol";
import { type CliContext, loadRoom } from "../context.js";
import { humanFrom } from "../human.js";
import { connectForPost } from "../room-post.js";
import { id8, safeBody, safeLine, stripTerminal } from "../safe-text.js";

const PREVIEW_CHARS = 1_500;
const SENT_TEXT_CHARS = 200;

const NO_DRAFT = "Not sent: no draft is pending.";

interface Stored {
  bytes: string;
  hash: unknown;
  rawEnv: unknown;
}

function readPending(path: string): Stored | undefined {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(bytes) as { hash?: unknown; env?: unknown };
  return { bytes, hash: parsed.hash, rawEnv: parsed.env };
}

const NOT_PREVIEWED =
  "Not sent: review the draft first. Type /agentroom:send with no hash; it shows the stored draft and the hash to type.";

/** Which draft hash the bare `/agentroom:send` last showed, and in which Claude Code session. */
const previewPath = (dir: string) => join(dir, "previewed.json");

function previewedIn(dir: string): { hash?: unknown; session?: unknown } {
  try {
    return JSON.parse(readFileSync(previewPath(dir), "utf8"));
  } catch {
    return {};
  }
}

/**
 * `/agentroom:send` with no hash: the stored draft, read from disk (KTD7, KTD10). Records the
 * shown hash for this session, so a release needs the user to have seen this text, not only
 * the model's rendering of it.
 */
export function previewDraft(ctx: CliContext, session: string): string {
  const { roomId } = loadRoom(undefined, ctx);
  const dir = roomDir(agentroomHome(ctx.env), roomId);
  const stored = readPending(join(dir, "pending.json"));
  if (!stored) return NO_DRAFT;
  const env = Envelope.parse(stored.rawEnv);
  writeAtomic(
    previewPath(dir),
    `${JSON.stringify({ hash: stored.hash, session })}\n`,
  );
  const hash = safeLine(String(stored.hash));
  let body = safeBody(env.body);
  if (body.length > PREVIEW_CHARS) {
    body = `${body.slice(0, PREVIEW_CHARS)}[truncated]`;
  }
  return [
    `Pending draft ${hash} (${env.kind}, thread ${id8(env.thread)}):`,
    body,
    `Type /agentroom:send ${hash} to send it.`,
  ].join("\n");
}

/**
 * `/agentroom:send <hash>` (KTD10): post the stored draft unchanged only when the typed hash,
 * the stored hash and a fresh hash of the stored envelope agree, a bare `/agentroom:send` showed
 * this hash in this session, and the envelope is this member's agent draft; then post a human
 * `approve` in its thread and clear the slot.
 */
export async function releaseDraft(
  typed: string,
  ctx: CliContext,
  session: string,
): Promise<string> {
  const { roomId, room } = loadRoom(undefined, ctx);
  const dir = roomDir(agentroomHome(ctx.env), roomId);
  const path = join(dir, "pending.json");
  const stored = readPending(path);
  if (!stored) return NO_DRAFT;
  if (
    typed.toLowerCase() !== stored.hash ||
    draftHash(stored.rawEnv as Envelope) !== stored.hash
  ) {
    return `Not sent: the pending draft changed after it was shown (now ${safeLine(String(stored.hash))}). Type /agentroom:send to preview it.`;
  }
  const shown = previewedIn(dir);
  if (shown.hash !== stored.hash || shown.session !== session) {
    return NOT_PREVIEWED;
  }
  const hash = stored.hash as string;
  const env = Envelope.parse(stored.rawEnv);
  if (
    env.from.member !== room.member ||
    env.from.via !== "hook" ||
    env.from.agent === "human" ||
    env.kind === "approve" ||
    env.kind === "presence"
  ) {
    return "Not sent: the pending draft is not an agent draft from this member.";
  }
  const s = await connectForPost(undefined, ctx);
  try {
    if (s.history.some((e) => e.id === env.id)) {
      return "Not sent: this draft was already sent.";
    }
    await s.post(env);
    if (readPending(path)?.bytes === stored.bytes) {
      rmSync(path, { force: true });
      rmSync(previewPath(dir), { force: true });
    }
    const thread = id8(env.thread);
    try {
      await s.post({
        v: 1,
        id: ulid(),
        ts: Date.now(),
        from: humanFrom(s.room, "hook"),
        kind: "approve",
        thread: env.thread,
        body: "",
      });
    } catch (err) {
      const cause = stripTerminal(
        err instanceof Error ? err.message : String(err),
      );
      return `Sent draft ${hash}, but the approval was not sent: ${cause}. Run /agentroom:approve ${thread} to retry.`;
    }
    const sent = safeBody(env.body).slice(0, SENT_TEXT_CHARS);
    return `Sent draft ${hash} to room ${roomId.slice(0, 8)} (thread ${thread}) and approved the thread as ${safeLine(room.member)} (human). Sent text: ${sent}`;
  } finally {
    s.end();
  }
}
