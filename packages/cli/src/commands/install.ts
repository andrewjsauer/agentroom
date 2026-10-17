import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentName,
  agentroomHome,
  findOnPath,
  roomExists,
} from "@agentroom/mcp";
import { installAdapter, isAdapterAgent } from "../adapters/index.js";
import {
  installAskRules,
  installStatusLine,
  isObject,
} from "../claude-settings.js";
import { type CliContext, CliError, resolveRoomId } from "../context.js";
import { writeConfigFile } from "../write-file.js";

/**
 * The stdio command an agent runs (plan KTD15): always the absolute node binary plus an absolute
 * entry file, never `npx`, which would prefer a copy in the opened repo's node_modules. Without a
 * room id it serves the current room (M4 KTD4), so the entry never names a room.
 */
export function mcpServerCommand(
  entryPath: string,
  roomId?: string,
  execPath = process.execPath,
): { command: string; args: string[] } {
  const tail = roomId ? ["mcp", "--room", roomId] : ["mcp"];
  return { command: execPath, args: [entryPath, ...tail] };
}

/**
 * An entry path that outlives this process. A global or local install, or a checkout, is used
 * as is. An npx cache entry (under `_npx`) can be evicted, so its `node_modules` tree (the
 * package and its dependencies) is copied once to `<AGENTROOM_HOME>/bin/<version>/` (0700).
 */
export function stableEntry(
  entryPath: string,
  ctx: CliContext,
): { entry: string; copiedTo?: string } {
  const parts = entryPath.split(sep);
  const npx = parts.indexOf("_npx");
  if (npx < 0 || npx + 2 >= parts.length) return { entry: entryPath };
  const source = join(parts.slice(0, npx + 2).join(sep), "node_modules");
  const rel = relative(source, entryPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return { entry: entryPath };
  const pkg = JSON.parse(
    readFileSync(join(dirname(entryPath), "..", "package.json"), "utf8"),
  ) as { version?: unknown };
  const version = String(pkg.version);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new CliError(
      `unexpected package version ${JSON.stringify(version)} in the npx copy`,
    );
  }
  const bin = join(agentroomHome(ctx.env), "bin");
  const dest = join(bin, version);
  const entry = join(dest, "node_modules", rel);
  if (!existsSync(entry)) {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    chmodSync(bin, 0o700);
    const tmp = mkdtempSync(join(bin, `.${version}-`));
    cpSync(source, join(tmp, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  return { entry, copiedTo: dest };
}

/** mcpServerCommand for this CLI's entry, copying an npx entry first and saying so. */
function serverCommand(
  ctx: CliContext,
  roomId?: string,
): { command: string; args: string[] } {
  const { entry, copiedTo } = stableEntry(ctx.entryPath, ctx);
  if (copiedTo !== undefined) {
    ctx.stdout.write(
      `agentroom is running from the npx cache, which can be cleared, so the MCP entry runs a copy in ${copiedTo}.\n`,
    );
  }
  return mcpServerCommand(entry, roomId);
}

/** Remove the M1 user-scope registration; a missing entry makes this fail, which is fine. */
function removeUserMcp(claude: string, ctx: CliContext): void {
  spawnSync(claude, ["mcp", "remove", "--scope", "user", "agentroom"], {
    env: ctx.env,
    stdio: "ignore",
  });
}

/** M1: register the room's MCP server with `claude mcp add`. */
function registerMcp(claude: string, roomId: string, ctx: CliContext): number {
  const { command, args } = serverCommand(ctx, roomId);
  removeUserMcp(claude, ctx);
  const add = spawnSync(
    claude,
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "agentroom",
      "--",
      command,
      ...args,
    ],
    { env: ctx.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (add.status !== 0) {
    ctx.stderr.write(
      `agentroom: \`claude mcp add\` failed (exit ${add.status}):\n${add.stderr}`,
    );
    return 1;
  }
  ctx.stdout.write(
    "Registered the agentroom MCP server with Claude Code (user scope). Restart Claude Code to load the tools.\n",
  );
  return 0;
}

/** M1 fallback without `claude` on PATH: a project `.mcp.json` entry. */
function writeProjectMcp(roomId: string, ctx: CliContext): void {
  const { command, args } = serverCommand(ctx, roomId);
  const file = join(ctx.cwd, ".mcp.json");
  let config: Record<string, unknown> = {};
  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      throw new CliError(
        `${file} is not a JSON object; fix or remove it, then rerun \`agentroom install claude\``,
      );
    }
    config = parsed;
  }
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  servers.agentroom = { type: "stdio", command, args };
  config.mcpServers = servers;
  writeConfigFile(file, `${JSON.stringify(config, null, 2)}\n`);
  ctx.stdout.write(
    `\`claude\` is not on PATH, so the server was written to ${file} (project scope). Do not commit that file: it names the room id. Restart Claude Code in this directory to load the tools.\n`,
  );
}

/** The checkout root holding the marketplace, when the entry is a checkout's dist/bin.js. */
function checkoutRoot(entryPath: string): string | undefined {
  if (entryPath.split(sep).includes("node_modules")) return undefined;
  const root = resolve(dirname(entryPath), "../../..");
  return existsSync(join(root, ".claude-plugin", "marketplace.json"))
    ? root
    : undefined;
}

function writeAskRules(ctx: CliContext): void {
  const file = installAskRules(ctx);
  if (file !== undefined) {
    ctx.stdout.write(
      `Claude Code will ask before agentroom posts to the room (permissions.ask in ${file}).\n`,
    );
  }
}

function writeStatusLine(ctx: CliContext): void {
  const file = installStatusLine(ctx);
  ctx.stdout.write(
    file === undefined
      ? "Neither CLAUDE_CONFIG_DIR nor HOME is set, so the status line was not installed.\n"
      : `Set the Claude Code status line in ${file} (your previous one, if any, is chained).\n`,
  );
}

/**
 * Set Claude Code up (KTD3): from a checkout with `claude` on PATH, install the plugin from the
 * repo-root marketplace; from an npm copy, register the MCP server (M1); without `claude`,
 * write `.mcp.json` (M1). The status line is written for checkout entries; the ask rules for posting tools always.
 */
function installClaude(roomId: string, ctx: CliContext): number {
  const claude = findOnPath(ctx.env.PATH, "claude");
  const root = checkoutRoot(ctx.entryPath);
  const npm = ctx.entryPath.split(sep).includes("node_modules");
  if (claude && root) {
    removeUserMcp(claude, ctx);
    const r = spawnSync(
      claude,
      [
        "plugin",
        "install",
        "agentroom",
        "--marketplace",
        root,
        "--scope",
        "user",
      ],
      { env: ctx.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.status !== 0) {
      ctx.stderr.write(
        `agentroom: \`claude plugin install\` failed (exit ${r.status}):\n${r.stderr}`,
      );
      return 1;
    }
    writeStatusLine(ctx);
    writeAskRules(ctx);
    ctx.stdout.write(
      "Installed the agentroom Claude Code plugin (user scope). Restart Claude Code to load the agentroom plugin (or run /reload-plugins), then type /agentroom:sync.\n",
    );
    return 0;
  }
  if (claude) {
    const code = registerMcp(claude, roomId, ctx);
    if (code !== 0) return code;
    writeAskRules(ctx);
    if (npm) {
      ctx.stdout.write(
        "The Claude Code plugin (hooks, /agentroom commands, status line) installs from a checkout for now; npm installs get it with the npm release.\n",
      );
    } else {
      writeStatusLine(ctx);
    }
    return 0;
  }
  writeProjectMcp(roomId, ctx);
  writeAskRules(ctx);
  if (!npm) {
    writeStatusLine(ctx);
    if (root) {
      ctx.stdout.write(
        `To load the plugin, start Claude Code with: claude --plugin-dir ${join(root, "plugins", "claude-code")}\n`,
      );
    }
  }
  return 0;
}

/** `agentroom install claude [--room <id>]` or `install codex|gemini|cursor [--project]`. */
export function install(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): number {
  const target = positionals[0];
  if (isAdapterAgent(target) && positionals.length === 1) {
    return installAdapter(
      target,
      values.project ? "project" : "user",
      serverCommand(ctx),
      ctx,
    );
  }
  if (target !== "claude" || values.project) {
    throw new CliError(
      `usage: agentroom install claude [--room <id>] | install codex|gemini|cursor [--project]${target ? ` (got "${target}")` : ""}`,
      2,
    );
  }
  const roomId = resolveRoomId(values.room, ctx);
  if (roomId === undefined || !roomExists(agentroomHome(ctx.env), roomId)) {
    throw new CliError(
      "no room to install; run `agentroom up` or `agentroom join <code>` first, or pass --room <id>",
    );
  }
  return installClaude(roomId, ctx);
}

/** After `up` or `join` wrote the room: install for the agent, or print the command for others. */
export function afterRoomReady(
  roomId: string,
  agent: AgentName,
  ctx: CliContext,
): number {
  if (agent === "claude-code") return installClaude(roomId, ctx);
  if (isAdapterAgent(agent)) {
    return installAdapter(agent, "user", serverCommand(ctx), ctx);
  }
  const { command, args } = serverCommand(ctx, roomId);
  ctx.stdout.write(
    `Add this stdio MCP server to your agent as "agentroom":\n  ${command} ${args.join(" ")}\nThen restart your agent session to load the tools.\n`,
  );
  return 0;
}
