import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/cli/dist/bin.js",
);

const run = promisify(execFile);

export function baseEnv(
  home: string,
  relayUrl: string,
): Record<string, string> {
  return {
    AGENTROOM_HOME: home,
    AGENTROOM_RELAY: relayUrl,
    PATH: dirname(process.execPath),
  };
}

/** Run the built CLI; resolves with stdout, rejects with the exec error (code, stdout, stderr). */
export async function cli(
  env: Record<string, string>,
  args: string[],
): Promise<string> {
  const { stdout } = await run(process.execPath, [BIN, ...args], { env });
  return stdout;
}

/** Spawn `agentroom mcp` as a real stdio child and connect an MCP client to it. */
export async function connectMcp(
  env: Record<string, string>,
  roomId: string,
  transports: StdioClientTransport[],
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", "--room", roomId],
    env,
    stderr: "inherit",
  });
  transports.push(transport);
  const client = new Client({ name: "conformance", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export interface Result {
  text: string;
  isError: boolean;
  structured: Record<string, unknown>;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text?: string }[];
  return {
    text: content.map((c) => c.text ?? "").join("\n"),
    isError: r.isError === true,
    structured: (r.structuredContent ?? {}) as Record<string, unknown>,
  };
}

export async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Close every client and wait for the MCP children to exit. */
export async function closeAll(
  clients: (Client | undefined)[],
  transports: StdioClientTransport[],
): Promise<void> {
  const pids = transports.map((t) => t.pid).filter((p): p is number => !!p);
  for (const c of clients) await c?.close();
  await until(
    () => (pids.every((p) => !alive(p)) ? true : undefined),
    "mcp children to exit",
    10_000,
  );
}
