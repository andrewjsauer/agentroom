import type { CliContext } from "../context.js";
import { runWatch } from "../watch/tui.js";

/** `agentroom watch [--room <id>]`. */
export function watch(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  return runWatch(values.room, ctx);
}
