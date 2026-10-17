import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRoomFile, readStatus } from "@agentroom/mcp";
import {
  deriveRoom,
  type Envelope,
  open,
  parseShareCode,
} from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, test } from "vitest";
import { baseEnv, call, cli, closeAll, until } from "./helpers.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(REPO, "plugins/claude-code");
const LAUNCHER = join(PLUGIN, "scripts/agentroom.mjs");
const FIXTURES = join(REPO, "packages/cli/test/fixtures/hooks");
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

let relay: RelayHandle;
let homeA: string;
let homeB: string;
let roomId: string;
let key: Uint8Array;
let project: string;
let alice: Client;
let bob: Client;
const transports: StdioClientTransport[] = [];

const envFor = (home: string) => baseEnv(home, relay.url);

/** The plugin's MCP server: the launcher with `mcp` and no --room (KTD4). */
async function connectPlugin(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCHER, "mcp"],
    env: envFor(home),
    cwd: home, // where `cli` ran up/join, so the room is served
    stderr: "inherit",
  });
  transports.push(transport);
  const client = new Client({ name: "claude-plugin", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Run a launcher subcommand as Claude Code would, with JSON on stdin. */
function runLauncher(
  args: string[],
  input: unknown,
  home = homeA,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { ...envFor(home), CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.once("exit", (code) => res({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

const submit = () =>
  runLauncher(["hook", "prompt-submit"], {
    ...fixture("user-prompt-submit.json"),
    cwd: project,
    prompt: "What did bob say?",
  });

/** A transcript file where Claude Code keeps them, which the expansion hook's origin check needs. */
function transcriptFor(home: string): string {
  const dir = join(home, "claude-config", "projects", "-project");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "");
  return file;
}

async function expand(command: string, args: string) {
  const r = await runLauncher(["hook", "prompt-expansion"], {
    ...fixture("user-prompt-expansion.json"),
    cwd: project,
    transcript_path: transcriptFor(homeA),
    command_name: `agentroom:${command}`,
    command_args: args,
    prompt: `/agentroom:${command} ${args}`,
  });
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as { decision: string; reason: string };
}

const relayEnvelopes = (): Promise<Envelope[]> =>
  Promise.all(
    (relay.snapshot(roomId)?.buffer ?? []).map((m) =>
      open(m.blob, key, roomId),
    ),
  );

beforeAll(async () => {
  relay = await startRelay({ port: 0, log: () => {} });
  homeA = mkdtempSync(join(tmpdir(), "agentroom-plugin-a-"));
  homeB = mkdtempSync(join(tmpdir(), "agentroom-plugin-b-"));
  const upOut = await cli(envFor(homeA), ["up", "--name", "alice"]);
  const code = upOut
    .split("\n")
    .find((l) => l.startsWith("ar1_"))
    ?.trim() as string;
  ({ roomId, key } = deriveRoom(parseShareCode(code)));
  await cli(envFor(homeB), ["join", code, "--name", "bob"]);
  project = readRoomFile(homeA, roomId).projectDir as string;
  alice = await connectPlugin(homeA);
  bob = await connectPlugin(homeB);
  await until(
    () => (readStatus(homeA, roomId)?.connections === 2 ? true : undefined),
    "both plugin servers live",
  );
}, 30_000);

afterAll(async () => {
  await closeAll([alice, bob], transports);
  await relay?.close();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

test("between delivery: framed once at the next prompt, then inbox has nothing", async () => {
  const sent = await call(bob, "send", {
    kind: "question",
    body: "Is the API stable?",
  });
  expect(sent.isError).toBe(false);
  await until(
    () => (readStatus(homeA, roomId)?.unread === 1 ? true : undefined),
    "alice's server to queue bob's question",
  );
  const first = await submit();
  expect(first.code).toBe(0);
  const ctx = JSON.parse(first.out).hookSpecificOutput.additionalContext;
  expect(ctx).toContain('from="bob/other"');
  expect(ctx).toContain("Is the API stable?");
  expect((await submit()).out).toBe("");
  expect((await call(alice, "inbox")).text).toBe("No unread messages.");
});

test("/agentroom:say reaches bob framed, from alice/human", async () => {
  const r = await expand("say", "Yes, stable since v2.");
  expect(r.decision).toBe("block");
  expect(r.reason).toMatch(/^Sent to room [0-9a-f]{8} as alice \(human\)/);
  await until(async () => {
    const text = (await call(bob, "inbox")).text;
    return text.includes("Yes, stable since v2.") ? text : undefined;
  }, "bob to receive alice's words").then((text) => {
    expect(text).toContain('from="alice/human"');
  });
});

test("/agentroom:send releases alice's agent draft and a human approve", async () => {
  const d = await call(alice, "send", {
    kind: "fyi",
    body: "Draft: we ship Friday.",
    draft: true,
  });
  const hash = d.structured.hash as string;
  // The bare preview prints the stored draft and its hash; a release requires it first.
  const preview = await expand("send", "");
  expect(preview.reason).toContain(`Type /agentroom:send ${hash} to send it.`);
  const r = await expand("send", hash);
  expect(r.reason).toMatch(new RegExp(`^Sent draft ${hash} to room`));
  const envs = await relayEnvelopes();
  const draft = envs.find((e) => e.body === "Draft: we ship Friday.");
  expect(draft?.from).toEqual({ member: "alice", agent: "other", via: "hook" });
  expect(envs.at(-1)).toMatchObject({
    kind: "approve",
    thread: draft?.thread,
    from: { member: "alice", agent: "human", via: "hook" },
  });
});

test("the chain limit stops bob; /agentroom:approve with no argument unblocks", async () => {
  const q = await call(bob, "send", { kind: "question", body: "one" });
  const id = q.structured.id as string;
  await call(bob, "send", { kind: "fyi", body: "two", replyTo: id });
  await call(bob, "send", { kind: "fyi", body: "three", replyTo: id });
  const refused = await call(bob, "send", {
    kind: "fyi",
    body: "four",
    replyTo: id,
  });
  expect(refused.text).toContain("This thread needs a human.");
  const r = await expand("approve", "");
  expect(r.reason).toMatch(/^Approved thread/);
  await until(async () => {
    const res = await call(bob, "send", {
      kind: "fyi",
      body: "four",
      replyTo: id,
    });
    return res.isError ? undefined : res;
  }, "bob to send after the approval");
});

test("the status line shows alice's unread count", async () => {
  await until(
    () => (readStatus(homeA, roomId)?.unread ? true : undefined),
    "alice to have unread messages",
  );
  // The count can still grow while bob's last send lands, so only its shape is pinned.
  const r = await runLauncher(["statusline"], {
    ...fixture("statusline.json"),
    cwd: project,
    workspace: { current_dir: project, project_dir: project },
  });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^agentroom \* [0-9a-f]{8} \| [1-9]\d* unread/);
  // The fixture's own directory is another project: no agentroom segment there.
  const other = await runLauncher(["statusline"], fixture("statusline.json"));
  expect(other.out).toBe("\n");
});

test("human envelopes come only from hook runs; MCP posts are never human", async () => {
  const envs = await relayEnvelopes();
  const human = envs.filter((e) => e.from.agent === "human");
  expect(human.length).toBeGreaterThanOrEqual(3);
  for (const e of human) expect(e.from.via).toBe("hook");
  for (const e of envs.filter((e) => e.from.via === "mcp")) {
    expect(e.from.agent).not.toBe("human");
  }
});
