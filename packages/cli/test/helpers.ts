import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { CliContext } from "../src/index.js";

export function tempDir(prefix = "agentroom-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface TestCtx {
  ctx: CliContext;
  out(): string;
  err(): string;
  stdin: PassThrough;
}

function collector(): { stream: Writable; read(): string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  });
  return { stream, read: () => buf };
}

/** A context whose home and PATH are temp dirs, so nothing real is touched or executed. */
export function makeCtx(
  home: string,
  overrides: Partial<CliContext> & { env?: NodeJS.ProcessEnv } = {},
): TestCtx {
  const out = collector();
  const err = collector();
  const stdin = new PassThrough();
  const ctx: CliContext = {
    env: {
      AGENTROOM_HOME: home,
      AGENTROOM_NOTIFY: "off",
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude-config"),
      PATH: tempDir("agentroom-path-"),
      ...overrides.env,
    },
    cwd: overrides.cwd ?? tempDir("agentroom-cwd-"),
    stdout: out.stream,
    stderr: err.stream,
    stdin,
    isTTY: overrides.isTTY ?? false,
    stdoutIsTTY: overrides.stdoutIsTTY ?? false,
    entryPath:
      overrides.entryPath ?? "/opt/agentroom-checkout/packages/cli/dist/bin.js",
  };
  return { ctx, out: out.read, err: err.read, stdin };
}

/** The share code printed by `up` (the only line that starts with the prefix). */
export function codeFrom(output: string): string {
  const line = output.split("\n").find((l) => l.startsWith("ar1_"));
  if (!line) throw new Error(`no share code in output:\n${output}`);
  return line.trim();
}
