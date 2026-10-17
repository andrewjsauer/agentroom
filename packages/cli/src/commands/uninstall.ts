import { spawnSync } from "node:child_process";
import { findOnPath } from "@agentroom/mcp";
import { isAdapterAgent, uninstallAdapter } from "../adapters/index.js";
import { uninstallAskRules, uninstallStatusLine } from "../claude-settings.js";
import { type CliContext, CliError } from "../context.js";

/**
 * `agentroom uninstall claude`: restore the status line, drop the ask rules, then remove the plugin (KTD18).
 * `uninstall codex|gemini|cursor [--project]`: remove the MCP entry and the snippet block.
 */
export function uninstall(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): number {
  const target = positionals[0];
  if (isAdapterAgent(target) && positionals.length === 1) {
    return uninstallAdapter(target, values.project ? "project" : "user", ctx);
  }
  if (target !== "claude" || positionals.length > 1 || values.project) {
    throw new CliError(
      "usage: agentroom uninstall claude | uninstall codex|gemini|cursor [--project]",
      2,
    );
  }
  ctx.stdout.write(`${uninstallStatusLine(ctx)}\n`);
  uninstallAskRules(ctx);
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
