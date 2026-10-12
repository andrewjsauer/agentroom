import { type CliContext, CliError } from "../context.js";
import { promptSubmit } from "../hook/submit.js";

/** `agentroom hook <event>`: entry points for the Claude Code plugin's hooks (KTD5). */
export async function hook(
  positionals: string[],
  ctx: CliContext,
): Promise<number> {
  const [sub] = positionals;
  if (sub === "prompt-submit") return promptSubmit(ctx);
  throw new CliError(
    `unknown hook "${sub ?? ""}"; use prompt-expansion or prompt-submit`,
    2,
  );
}
