import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  BIN,
  baseEnv,
  call,
  cli,
  closeAll,
  connectMcp,
  until,
} from "./helpers.js";

const ALICE = "alice-7f3a";
const BOB = "bob-9c1e";
const CAROL = "carol-2b8d";
const MSG_TAG = /<agentroom_message_[0-9a-f]{12} /g;

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

const envFor = (home: string, extra: Record<string, string> = {}) => ({
  ...baseEnv(home, relay.url),
  ...extra,
});
const connect = (home: string) => connectMcp(envFor(home), roomId, transports);

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

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`build the CLI first: ${BIN} is missing`);
  }
  relay = await relayFactory();
  homeA = mkdtempSync(join(tmpdir(), "agentroom-conf-a-"));
  homeB = mkdtempSync(join(tmpdir(), "agentroom-conf-b-"));

  const upOut = await cli(envFor(homeA), [
    "up",
    "--name",
    ALICE,
    "--agent",
    "codex",
  ]);
  const codeLine = upOut.split("\n").find((l) => l.startsWith("ar1_"));
  if (!codeLine) throw new Error(`no share code in up output:\n${upOut}`);
  code = codeLine.trim();
  ({ roomId, key } = deriveRoom(parseShareCode(code)));
  const joinOut = await cli(envFor(homeB), [
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
  await closeAll([alice, bob], transports);
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

/** Stand-in for a human `approve` from alice's CLI (say/approve need a real TTY). */
async function humanApprove(thread: string): Promise<void> {
  const id = `01APPROVE${Date.now()}`;
  relay.inject(
    roomId,
    await seal(
      {
        v: 1,
        id,
        ts: Date.now(),
        from: { member: ALICE, agent: "human", via: "cli" },
        kind: "approve",
        thread,
        body: "",
      },
      key,
      roomId,
    ),
  );
}

test("chain limit: bob's fourth agent message in a thread is refused until a human approves", async () => {
  const q = await call(alice, "send", { kind: "question", body: marker("c1") });
  const thread = q.structured.id as string;
  await until(async () => {
    const r = await call(bob, "inbox");
    return r.text.includes(thread) ? r : undefined;
  }, "bob sees q");
  const a = await call(bob, "send", {
    kind: "answer",
    body: marker("c2"),
    replyTo: thread,
  });
  expect(a.isError).toBe(false);
  await until(async () => {
    const r = await call(alice, "inbox");
    return r.text.includes(thread) ? r : undefined;
  }, "alice sees a");
  const q2 = await call(alice, "send", {
    kind: "question",
    body: marker("c3"),
    replyTo: a.structured.id,
  });
  expect(q2.isError).toBe(false);
  const waiting = (count: number) => async () => {
    const r = await call(bob, "room_status");
    const w = r.structured.waitingOnHuman as {
      thread: string;
      count: number;
    }[];
    const n = w.find((x) => x.thread === thread)?.count ?? 0;
    return n === count ? r : undefined;
  };
  await until(waiting(3), "bob counts 3 agent messages");
  const head = relay.snapshot(roomId)?.seq;
  const blocked = await call(bob, "send", {
    kind: "answer",
    body: marker("c4"),
    thread,
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain(
    "This thread needs a human. 3 agent messages in a row without a human reply.",
  );
  expect(relay.snapshot(roomId)?.seq).toBe(head);
  await humanApprove(thread);
  await until(waiting(0), "bob sees the approval");
  const ok = await call(bob, "send", {
    kind: "answer",
    body: marker("c5"),
    thread,
  });
  expect(ok.isError).toBe(false);
  expect(ok.structured.seq).toBe((head as number) + 2);
  await call(alice, "inbox");
  await call(bob, "inbox");
}, 40_000);

test("a fake AWS key over stdio is blocked naming the rule and never reaches the relay", async () => {
  const fake = ["AKIA", "Z7Q2K4M6N3P5R2T4"].join("");
  markers.push(fake);
  const head = relay.snapshot(roomId)?.seq;
  const r = await call(alice, "send", { kind: "fyi", body: `key ${fake}` });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("aws-access-key-id");
  expect(r.text).not.toContain(fake);
  expect(relay.snapshot(roomId)?.seq).toBe(head);
});

test("agentroom say run with CLAUDECODE=1 exits non-zero naming the marker and posts nothing", async () => {
  const head = relay.snapshot(roomId)?.seq;
  const body = marker("say");
  const err = await cli(envFor(homeA, { CLAUDECODE: "1" }), ["say", body]).then(
    () => undefined,
    (e: { code: number; stderr: string }) => e,
  );
  expect(err?.code).not.toBe(0);
  expect(err?.stderr).toContain("CLAUDECODE is set");
  expect(relay.snapshot(roomId)?.seq).toBe(head);
});

test("the relay holds no plaintext, and every stored envelope from the agents is agent-tagged via mcp", async () => {
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
  const fromAgents: Envelope[] = [];
  for (const m of snap.buffer) {
    const env = await open(m.blob, key, roomId);
    if (env.from.member === ALICE || env.from.member === BOB) {
      fromAgents.push(env);
    }
  }
  // The one human envelope is the approve this test injected for alice.
  const human = fromAgents.filter((e) => e.kind === "approve");
  expect(human).toHaveLength(1);
  expect(human[0]?.from).toEqual({ member: ALICE, agent: "human", via: "cli" });
  const agents = fromAgents.filter((e) => e.kind !== "approve");
  expect(agents.length).toBeGreaterThanOrEqual(5);
  for (const env of agents) {
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
