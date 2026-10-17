import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findOnPath } from "@agentroom/mcp";
import { isAdapterAgent, uninstallAdapter } from "../adapters/index.js";
import {
  isObject,
  uninstallAskRules,
  uninstallStatusLine,
} from "../claude-settings.js";
import { type CliContext, CliError } from "../context.js";
import { writeConfigFile } from "../write-file.js";

/** Drop `mcpServers.agentroom` from `<cwd>/.mcp.json` (the no-`claude` install), keeping the rest. */
function removeProjectMcp(ctx: CliContext): void {
  const file = join(ctx.cwd, ".mcp.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    config = undefined;
  }
  if (!isObject(config)) {
    ctx.stdout.write(
      `${file} is not a JSON object; left it as is. Remove any agentroom entry by hand.\n`,
    );
    return;
  }
  const servers = config.mcpServers;
  if (!isObject(servers) || !("agentroom" in servers)) return;
  delete servers.agentroom;
  writeConfigFile(file, `${JSON.stringify(config, null, 2)}\n`);
  ctx.stdout.write(`Removed the agentroom server from ${file}.\n`);
}

/**
 * `agentroom uninstall claude`: restore the status line, drop the ask rules and the project
 * `.mcp.json` entry, then remove the user-scope MCP registration and the plugin (KTD18).
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
  removeProjectMcp(ctx);
  const claude = findOnPath(ctx.env.PATH, "claude");
  if (claude === undefined) {
    ctx.stdout.write(
      "`claude` is not on PATH; remove the agentroom plugin and any user-scope agentroom MCP server from Claude Code with /plugin and /mcp if you installed them.\n",
    );
    return 0;
  }
  // The npm path registers a user-scope server; a missing entry makes this fail, which is fine.
  const mcp = spawnSync(
    claude,
    ["mcp", "remove", "--scope", "user", "agentroom"],
    { env: ctx.env, stdio: "ignore" },
  );
  if (mcp.status === 0) {
    ctx.stdout.write("Removed the user-scope agentroom MCP server.\n");
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
