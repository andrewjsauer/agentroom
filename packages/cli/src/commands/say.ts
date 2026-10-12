import { type Envelope, resolveThread, ulid } from "@agentroom/protocol";
import { type CliContext, CliError } from "../context.js";
import {
  HUMAN_MESSAGE_REASON,
  humanFrom,
  requireHumanTerminal,
} from "../human.js";
import { connectForPost } from "../room-post.js";
import { safeLine } from "../safe-text.js";

/** The highest-seq non-presence envelope, optionally within one thread. */
function lastOf(history: Envelope[], thread?: string): Envelope | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i] as Envelope;
    if (
      e.kind !== "presence" &&
      (thread === undefined || e.thread === thread)
    ) {
      return e;
    }
  }
  return undefined;
}

/**
 * Where a human message goes (KTD20): a new thread with `isNew`, else the latest message of
 * `thread` (which must exist) or of the whole room; a new thread when the room is empty.
 */
export function sayTarget(
  history: Envelope[],
  id: string,
  opts: { thread?: string; isNew: boolean },
): { thread: string; replyTo?: string } {
  if (opts.isNew) return { thread: id };
  const target =
    opts.thread === undefined
      ? lastOf(history)
      : lastOf(history, resolveThread({ id, thread: opts.thread }, history));
  return target
    ? { thread: target.thread, replyTo: target.id }
    : { thread: id };
}

/** Post the user's own words, tagged human (KTD20). Replies to the latest thread by default. */
export async function say(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  requireHumanTerminal(ctx, { stdout: true, reason: HUMAN_MESSAGE_REASON });
  const body = positionals.join(" ");
  if (body.trim() === "") throw new CliError("say needs a message", 2);
  if (values.thread !== undefined && values.new !== undefined) {
    throw new CliError("use either --thread or --new, not both", 2);
  }

  const s = await connectForPost(values.room, ctx);
  try {
    const id = ulid();
    const { thread, replyTo } = sayTarget(s.history, id, {
      thread: values.thread,
      isNew: values.new !== undefined,
    });
    const seq = await s.post({
      v: 1,
      id,
      ts: Date.now(),
      from: humanFrom(s.room, "cli"),
      kind: replyTo === undefined ? "question" : "answer",
      thread,
      replyTo,
      body,
    });
    const where = replyTo === undefined ? "new thread" : "thread";
    ctx.stdout.write(`Sent to ${where} ${safeLine(thread)} as seq ${seq}.\n`);
    return 0;
  } finally {
    s.end();
  }
}
