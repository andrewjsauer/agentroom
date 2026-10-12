import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type CliContext, CliError } from "../context.js";
import { removeJsonEntry, setJsonEntry } from "./json-config.js";
import { removeBlock, upsertBlock } from "./snippet.js";
import {
  removeAgentroomTable,
  type ServerEntry,
  setAgentroomTable,
} from "./toml.js";

export const ADAPTER_AGENTS = ["codex", "gemini", "cursor"] as const;
export type AdapterAgent = (typeof ADAPTER_AGENTS)[number];
export type Scope = "user" | "project";

interface Adapter {
  label: string;
  /** Config dir for user scope; project scope uses `<repo root>/<projectDir>`. */
  userDir(env: NodeJS.ProcessEnv, home: string): string;
  projectDir: string;
  configFile: string;
  write(text: string, file: string, entry: ServerEntry): string;
  remove(text: string, file: string): string;
  snippetFile: string;
}

const ADAPTERS: Record<AdapterAgent, Adapter> = {
  codex: {
    label: "Codex",
    // Codex reads CODEX_HOME when set and non-empty (OPEN_QUESTIONS item 10).
    userDir: (env, home) => env.CODEX_HOME || join(home, ".codex"),
    projectDir: ".codex",
    configFile: "config.toml",
    write: setAgentroomTable,
    remove: removeAgentroomTable,
    snippetFile: "AGENTS.md",
  },
  gemini: {
    label: "Gemini CLI",
    userDir: (_env, home) => join(home, ".gemini"),
    projectDir: ".gemini",
    configFile: "settings.json",
    write: (text, file, entry) => setJsonEntry(text, file, entry),
    remove: removeJsonEntry,
    snippetFile: "GEMINI.md",
  },
  cursor: {
    label: "Cursor",
    userDir: (_env, home) => join(home, ".cursor"),
    projectDir: ".cursor",
    configFile: "mcp.json",
    write: (text, file, entry) =>
      setJsonEntry(text, file, { type: "stdio", ...entry }),
    remove: removeJsonEntry,
    snippetFile: "AGENTS.md",
  },
};

export function isAdapterAgent(name: string | undefined): name is AdapterAgent {
  return (ADAPTER_AGENTS as readonly string[]).includes(name ?? "");
}

/** The nearest ancestor of `cwd` holding `.git`, or `cwd` itself. */
export function repoRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

function configPath(
  agent: AdapterAgent,
  scope: Scope,
  ctx: CliContext,
): string {
  const a = ADAPTERS[agent];
  if (scope === "project")
    return join(repoRoot(ctx.cwd), a.projectDir, a.configFile);
  const home = ctx.env.HOME;
  if (!home)
    throw new CliError(
      "HOME is not set; pass --project to write the repo's config instead",
    );
  return join(a.userDir(ctx.env, home), a.configFile);
}

const readText = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : "";

/** Compute every change first, so a refused file leaves all files untouched (R9). */
function applyAll(
  changes: { file: string; next: (text: string) => string }[],
): string[] {
  const planned = changes.map(({ file, next }) => {
    const before = readText(file);
    return { file, before, after: next(before) };
  });
  const changed: string[] = [];
  for (const { file, before, after } of planned) {
    if (after === before) continue;
    if (after === "") {
      rmSync(file, { force: true });
    } else {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.agentroom-tmp`;
      writeFileSync(tmp, after);
      renameSync(tmp, file);
    }
    changed.push(`${after === "" ? "Removed" : "Updated"} ${file}`);
  }
  return changed;
}

/** `install codex|gemini|cursor`: the MCP entry plus the marker-delimited snippet. */
export function installAdapter(
  agent: AdapterAgent,
  scope: Scope,
  entry: ServerEntry,
  ctx: CliContext,
): number {
  const a = ADAPTERS[agent];
  const config = configPath(agent, scope, ctx);
  const changed = applyAll([
    { file: config, next: (t) => a.write(t, config, entry) },
    {
      file: join(repoRoot(ctx.cwd), a.snippetFile),
      next: (t) => upsertBlock(t),
    },
  ]);
  for (const line of changed) ctx.stdout.write(`${line}\n`);
  ctx.stdout.write(
    changed.length === 0
      ? `agentroom is already installed for ${a.label}.\n`
      : `Restart ${a.label} to load the agentroom tools.\n`,
  );
  return 0;
}

/** `uninstall codex|gemini|cursor`: remove only our entry and block. */
export function uninstallAdapter(
  agent: AdapterAgent,
  scope: Scope,
  ctx: CliContext,
): number {
  const a = ADAPTERS[agent];
  const config = configPath(agent, scope, ctx);
  const changed = applyAll([
    { file: config, next: (t) => a.remove(t, config) },
    { file: join(repoRoot(ctx.cwd), a.snippetFile), next: removeBlock },
  ]);
  for (const line of changed) ctx.stdout.write(`${line}\n`);
  if (changed.length === 0) {
    ctx.stdout.write(`Nothing to remove for ${a.label}.\n`);
  }
  return 0;
}
