import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readRoomFile, readStatus } from "@agentroom/mcp";
import {
  deriveRoom,
  type Envelope,
  FRAME_REMINDER,
  open,
  parseShareCode,
  seal,
} from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, test } from "vitest";

const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/cli/dist/bin.js",
);
const ALICE = "alice-7f3a";
const BOB = "bob-9c1e";
const CAROL = "carol-2b8d";
const MSG_TAG = /<agentroom_message_[0-9a-f]{12} /g;
const run = promisify(execFile);

/** Relay factory per plan KTD1; a second relay implementation plugs in here. */
const relayFactory = () => startRelay({ port: 0, log: () => {} });

let relay: RelayHandle;
let homeA: string;
let homeB: string;
let roomId: string;
let code: string;
let key: Uint8Array;
let alice: Client;
let bob: Client;
const transports: StdioClientTransport[] = [];
const markers: string[] = [];

function envFor(home: string): Record<string, string> {
  return {
    AGENTROOM_HOME: home,
    AGENTROOM_RELAY: relay.url,
    PATH: dirname(process.execPath),
  };
}

async function cli(home: string, args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [BIN, ...args], {
    env: envFor(home),
  });
  return stdout;
}

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", "--room", roomId],
    env: envFor(home),
    stderr: "inherit",
  });
  transports.push(transport);
  const client = new Client({ name: "conformance", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

interface Result {
  text: string;
  isError: boolean;
  structured: Record<string, unknown>;
}

async function call(
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

async function until<T>(
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

function marker(label: string): string {
  const m = `${label}-${Math.random().toString(16).slice(2, 10)}`;
  markers.push(m);
  return m;
}

/** Invariant 5: a tool result carrying messages is framed and followed by the reminder. */
function expectFramed(text: string, count: number): void {
  expect(text.match(MSG_TAG) ?? []).toHaveLength(count);
  expect(text.split(FRAME_REMINDER)).toHaveLength(count + 1);
  const closes = text.match(/<\/agentroom_message_[0-9a-f]{12}>/g) ?? [];
  expect(closes).toHaveLength(count);
}

function expectStatusFramed(text: string): void {
  const open = text.indexOf('<agentroom_members untrusted="true">');
  const close = text.indexOf("</agentroom_members>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  expect(text.indexOf(FRAME_REMINDER)).toBeGreaterThan(close);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`build the CLI first: ${BIN} is missing`);
  }
  relay = await relayFactory();
  homeA = mkdtempSync(join(tmpdir(), "agentroom-conf-a-"));
  homeB = mkdtempSync(join(tmpdir(), "agentroom-conf-b-"));

  const upOut = await cli(homeA, ["up", "--name", ALICE, "--agent", "codex"]);
  const codeLine = upOut.split("\n").find((l) => l.startsWith("ar1_"));
  if (!codeLine) throw new Error(`no share code in up output:\n${upOut}`);
  code = codeLine.trim();
  ({ roomId, key } = deriveRoom(parseShareCode(code)));
  const joinOut = await cli(homeB, [
    "join",
    code,
    "--name",
    BOB,
    "--agent",
    "codex",
  ]);
  expect(joinOut).toContain(`Joined room ${roomId} as ${BOB} (codex)`);
  expect(readRoomFile(homeB, roomId).secret).toBe(code);

  alice = await connect(homeA);
  bob = await connect(homeB);
}, 30_000);

afterAll(async () => {
  const pids = transports.map((t) => t.pid).filter((p): p is number => !!p);
  await alice?.close();
  await bob?.close();
  await until(
    () => (pids.every((p) => !alive(p)) ? true : undefined),
    "mcp children to exit",
    10_000,
  );
  await relay.close();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

test("two agents see each other in room_status", async () => {
  const sees = (client: Client, other: string) => async () => {
    const r = await call(client, "room_status");
    return r.text.includes(`- ${other}/`) && r.structured.connections === 2
      ? r
      : undefined;
  };
  const a = await until(sees(alice, BOB), "alice sees bob");
  const b = await until(sees(bob, ALICE), "bob sees alice");
  expectStatusFramed(a.text);
  expectStatusFramed(b.text);
  expect(a.structured.decryptFailures).toBe(0);
}, 20_000);

test("question and answer travel framed with the right from, kind and thread", async () => {
  const q = marker("question");
  const sent = await call(alice, "send", { kind: "question", body: q });
  expect(sent.isError).toBe(false);
  const qid = sent.structured.id as string;

  const got = await call(bob, "wait", { timeoutSec: 20 });
  expectFramed(got.text, 1);
  expect(got.text).toContain(q);
  expect(got.text).toContain(`from="${ALICE}/codex"`);
  expect(got.text).toContain('kind="question"');
  expect(got.text).toContain(`thread="${qid}"`);

  const a = marker("answer");
  const reply = await call(bob, "send", {
    kind: "answer",
    body: a,
    replyTo: qid,
  });
  expect(reply.isError).toBe(false);

  const inbox = await until(async () => {
    const r = await call(alice, "inbox");
    return r.text.includes(a) ? r : undefined;
  }, "alice inbox");
  expectFramed(inbox.text, 1);
  expect(inbox.text).toContain(`from="${BOB}/codex"`);
  expect(inbox.text).toContain('kind="answer"');
  expect(inbox.text).toContain(`thread="${qid}"`);
}, 30_000);

test("both sides resume after a forced disconnect and receive an injected message once", async () => {
  relay.setAccepting(false);
  relay.disconnectAll();
  const inBackoff = (client: Client) => async () => {
    const r = await call(client, "room_status");
    return r.structured.connection === "backoff" ? true : undefined;
  };
  await until(inBackoff(alice), "alice in backoff");
  await until(inBackoff(bob), "bob in backoff");

  const c = marker("carol");
  const secret = parseShareCode(readRoomFile(homeB, roomId).secret);
  const env: Envelope = {
    v: 1,
    id: "01CAROL000000000000000000A",
    ts: Date.now(),
    from: { member: CAROL, agent: "codex", via: "mcp" },
    kind: "fyi",
    thread: "01CAROL000000000000000000A",
    body: c,
    refs: [],
    requiresHuman: false,
  };
  relay.inject(roomId, await seal(env, deriveRoom(secret).key, roomId));
  relay.setAccepting(true);

  for (const client of [alice, bob]) {
    const got = await call(client, "wait", { timeoutSec: 20 });
    expectFramed(got.text, 1);
    expect(got.text.split(c)).toHaveLength(2);
    expect(got.text).toContain(`from="${CAROL}/codex"`);
    expect((await call(client, "inbox")).text).toBe("No unread messages.");
  }
}, 40_000);

test("the relay holds no plaintext, and every stored envelope is agent-tagged via mcp", async () => {
  const snap = relay.snapshot(roomId);
  expect(snap).toBeDefined();
  if (!snap) return;
  const needles = [...markers, ALICE, BOB, CAROL, code];
  const haystacks = [
    JSON.stringify(snap),
    ...snap.buffer.map((m) => Buffer.from(m.blob, "base64").toString("latin1")),
    Buffer.from(snap.meta, "base64").toString("latin1"),
  ];
  for (const h of haystacks) {
    for (const n of needles) expect(h).not.toContain(n);
  }
  expect(snap.buffer.length).toBeGreaterThanOrEqual(5);
  for (const m of snap.buffer) {
    const env = await open(m.blob, key, roomId);
    expect(env.from.via).toBe("mcp");
    expect(env.from.agent).not.toBe("human");
  }
});

test("the mcp child exits shortly after its stdin closes", async () => {
  const child = spawn(process.execPath, [BIN, "mcp", "--room", roomId], {
    env: envFor(homeA),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exit = new Promise<number | null>((r) => child.once("exit", r));
  await until(
    () => (readStatus(homeA, roomId)?.connection === "live" ? true : undefined),
    "child live",
  );
  child.stdin.end();
  const code = await Promise.race([
    exit,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
  ]);
  expect(code).not.toBe("timeout");
}, 20_000);

test("mcp with a missing room exits non-zero and writes nothing to stdout", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentroom-conf-none-"));
  try {
    const child = spawn(
      process.execPath,
      [BIN, "mcp", "--room", "f".repeat(64)],
      { env: envFor(home), stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    const exitCode = await new Promise<number | null>((r) =>
      child.once("exit", r),
    );
    expect(exitCode).not.toBe(0);
    expect(out).toBe("");
    expect(err).toContain("agentroom:");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
