import { spawnSync } from "node:child_process";
import { findOnPath } from "@agentroom/mcp";
import { uninstallStatusLine } from "../claude-settings.js";
import { type CliContext, CliError } from "../context.js";

/** `agentroom uninstall claude`: restore the status line, then remove the plugin (KTD18). */
export function uninstall(positionals: string[], ctx: CliContext): number {
  if (positionals[0] !== "claude" || positionals.length > 1) {
    throw new CliError('uninstall supports only "claude"', 2);
  }
  ctx.stdout.write(`${uninstallStatusLine(ctx)}\n`);
  const claude = findOnPath(ctx.env.PATH, "claude");
  if (claude === undefined) {
    ctx.stdout.write(
      "`claude` is not on PATH; remove the agentroom plugin from Claude Code with /plugin if you installed it.\n",
    );
    return 0;
  }
  const r = spawnSync(
    claude,
    ["plugin", "uninstall", "agentroom@agentroom", "--scope", "user"],
    { env: ctx.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  ctx.stdout.write(
    r.status === 0
      ? "Removed the agentroom Claude Code plugin.\n"
      : `\`claude plugin uninstall\` failed (exit ${r.status}): ${r.stderr}`,
  );
  return 0;
}
