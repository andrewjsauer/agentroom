import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentroomHome, writeAtomic } from "@agentroom/mcp";
import { type CliContext, CliError } from "./context.js";

/** POSIX single-quoting for one shell word. */
export const shellQuote = (s: string): string =>
  `'${s.replace(/'/g, `'\\''`)}'`;

type Json = Record<string, unknown>;

interface InstallState {
  v: 1;
  /** The user's statusLine before the first install, or null when there was none. */
  original: Json | null;
  /** The command install wrote, so a moved checkout is still recognized as ours. */
  installed: string;
}

/** `<CLAUDE_CONFIG_DIR or $HOME/.claude>/settings.json`; undefined when neither is set. */
function claudeSettingsPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CLAUDE_CONFIG_DIR)
    return join(env.CLAUDE_CONFIG_DIR, "settings.json");
  if (env.HOME) return join(env.HOME, ".claude", "settings.json");
  return undefined;
}

const statePath = (ctx: CliContext) =>
  join(agentroomHome(ctx.env), "claude-install.json");

export const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read settings.json; missing is `{}`, anything but a JSON object aborts naming the file. */
function readSettings(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    throw new CliError(`${file} is not a JSON object; fix it, then rerun`);
  }
  return parsed;
}

function readState(ctx: CliContext): InstallState | undefined {
  try {
    const s = JSON.parse(readFileSync(statePath(ctx), "utf8"));
    return isObject(s) && typeof s.installed === "string"
      ? (s as unknown as InstallState)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The status line command prefix: quoted node and checkout entry (M1 KTD15, never npx). */
const prefix = (ctx: CliContext) =>
  `${shellQuote(process.execPath)} ${shellQuote(ctx.entryPath)}`;

function isOurs(
  current: unknown,
  ctx: CliContext,
  state: InstallState | undefined,
): boolean {
  const command = isObject(current) ? current.command : undefined;
  if (typeof command !== "string") return false;
  return (
    command === state?.installed ||
    (command.startsWith(prefix(ctx)) && command.includes(" statusline"))
  );
}

/**
 * Point Claude Code's status line at `agentroom statusline`, chaining the user's own command
 * (KTD18). Idempotent: a second run recomputes from the saved original. Returns the file.
 */
export function installStatusLine(ctx: CliContext): string | undefined {
  const file = claudeSettingsPath(ctx.env);
  if (file === undefined) return undefined;
  const settings = readSettings(file);
  const state = readState(ctx);
  const ours = isOurs(settings.statusLine, ctx, state);
  // Ours but the saved original is gone: keep the line, whose --chain still holds it.
  if (ours && state === undefined) return file;
  const original = ours
    ? (state?.original ?? null)
    : isObject(settings.statusLine)
      ? settings.statusLine
      : null;
  const chained =
    typeof original?.command === "string"
      ? ` --chain ${shellQuote(original.command)}`
      : "";
  const command = `${prefix(ctx)} statusline${chained}`;
  settings.statusLine = {
    type: "command",
    command,
    padding: original?.padding ?? 0,
    refreshInterval: original?.refreshInterval ?? 10,
  };
  writeAtomic(
    statePath(ctx),
    `${JSON.stringify({ v: 1, original, installed: command } satisfies InstallState)}\n`,
  );
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

/** Restore the saved status line when the current one is still ours (KTD18). */
export function uninstallStatusLine(ctx: CliContext): string {
  const file = claudeSettingsPath(ctx.env);
  const state = readState(ctx);
  if (file === undefined || state === undefined) {
    return "No agentroom status line install was recorded.";
  }
  const settings = readSettings(file);
  let text: string;
  if (isOurs(settings.statusLine, ctx, state)) {
    if (state.original === null) delete settings.statusLine;
    else settings.statusLine = state.original;
    writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
    text = `Restored your previous status line in ${file}.`;
  } else {
    text = `The status line in ${file} changed since install; left it as is.`;
  }
  rmSync(statePath(ctx), { force: true });
  return text;
}

/** The tools that post to the room, under the plugin's and the plain MCP entry's names. */
export const ASK_TOOLS = [
  "mcp__plugin_agentroom_agentroom__send",
  "mcp__plugin_agentroom_agentroom__handoff",
  "mcp__agentroom__send",
  "mcp__agentroom__handoff",
];

/**
 * Add ASK_TOOLS to `permissions.ask`, so Claude Code asks before each post to the room even in
 * auto or accept-edits mode. Keeps every other rule; idempotent. Returns the file.
 */
export function installAskRules(ctx: CliContext): string | undefined {
  const file = claudeSettingsPath(ctx.env);
  if (file === undefined) return undefined;
  const settings = readSettings(file);
  const permissions = isObject(settings.permissions)
    ? settings.permissions
    : {};
  const ask = Array.isArray(permissions.ask) ? permissions.ask : [];
  const missing = ASK_TOOLS.filter((t) => !ask.includes(t));
  if (missing.length > 0) {
    permissions.ask = [...ask, ...missing];
    settings.permissions = permissions;
    writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return file;
}

/** Remove ASK_TOOLS from `permissions.ask`, dropping `ask` and `permissions` if left empty. */
export function uninstallAskRules(ctx: CliContext): void {
  const file = claudeSettingsPath(ctx.env);
  if (file === undefined) return;
  const settings = readSettings(file);
  const permissions = settings.permissions;
  if (!isObject(permissions) || !Array.isArray(permissions.ask)) return;
  const ask = permissions.ask.filter((t) => !ASK_TOOLS.includes(t));
  if (ask.length === permissions.ask.length) return;
  if (ask.length > 0) permissions.ask = ask;
  else delete permissions.ask;
  if (Object.keys(permissions).length === 0) delete settings.permissions;
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}
