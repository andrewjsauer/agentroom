import { resolveThread, ulid } from "@agentroom/protocol";
import { type CliContext, CliError } from "../context.js";
import {
  HUMAN_MESSAGE_REASON,
  humanFrom,
  requireHumanTerminal,
} from "../human.js";
import { connectForPost } from "../room-post.js";
import { safeLine } from "../safe-text.js";

/** Post a human `approve` to a known thread, which resets its chain limit. */
export async function approve(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  requireHumanTerminal(ctx, { stdout: true, reason: HUMAN_MESSAGE_REASON });
  const [requested, ...extra] = positionals;
  if (requested === undefined || extra.length > 0) {
    throw new CliError("approve needs exactly one thread id", 2);
  }
  const s = await connectForPost(values.room, ctx);
  try {
    const id = ulid();
    const thread = resolveThread({ id, thread: requested }, s.history);
    const seq = await s.post({
      v: 1,
      id,
      ts: Date.now(),
      from: humanFrom(s.room, "cli"),
      kind: "approve",
      thread,
      body: "",
    });
    ctx.stdout.write(`Approved thread ${safeLine(thread)} as seq ${seq}.\n`);
    return 0;
  } finally {
    s.end();
  }
}
