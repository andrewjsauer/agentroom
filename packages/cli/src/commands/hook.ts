import { type CliContext, CliError } from "../context.js";

/** `agentroom hook <event>`: entry points for the Claude Code plugin's hooks (KTD5). */
export async function hook(
  positionals: string[],
  _ctx: CliContext,
): Promise<number> {
  const [sub] = positionals;
  throw new CliError(
    `unknown hook "${sub ?? ""}"; use prompt-expansion or prompt-submit`,
    2,
  );
}
