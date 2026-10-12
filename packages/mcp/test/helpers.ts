import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveRoom,
  type EnvelopeKind,
  generateCloseKeyPair,
  generateShareCode,
  seal,
  sealMeta,
  signClose,
  ulid,
} from "@agentroom/protocol";
import type { RelayHandle } from "@agentroom/relay-node";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  type AgentName,
  connectOnce,
  createMcpServer,
  createRoomSession,
  oneShot,
  type RoomSession,
  setCurrent,
  writeRoomFile,
} from "../src/index.js";

export interface TestRoom {
  code: string;
  roomId: string;
  key: Uint8Array;
  closeSecretKey: string;
}

/** Generate a share code and create the room on the relay. */
export async function createTestRoom(
  relay: RelayHandle,
  settings: { maxAgentChain?: number } = {},
): Promise<TestRoom> {
  const { code, secret } = generateShareCode();
  const { roomId, key } = deriveRoom(secret);
  const meta = await sealMeta(settings, key, roomId);
  const close = await generateCloseKeyPair();
  const res = await oneShot({
    url: relay.url,
    hello: {
      t: "hello",
      room: roomId,
      proto: 1,
      create: { closeKey: close.publicKey, meta },
    },
  });
  if (res.t !== "welcome") throw new Error(`create failed: ${res.code}`);
  return { code, roomId, key, closeSecretKey: close.secretKey };
}

/** Stand-in for CLI `say`/`approve`: a human-tagged envelope sealed with the room key. */
export async function injectHuman(
  relay: RelayHandle,
  room: TestRoom,
  opts: { kind: EnvelopeKind; thread: string; body?: string },
): Promise<string> {
  const id = ulid();
  const blob = await seal(
    {
      v: 1,
      id,
      ts: Date.now(),
      from: { member: "alice", agent: "human", via: "cli" },
      kind: opts.kind,
      thread: opts.thread,
      body: opts.body ?? "",
    },
    room.key,
    room.roomId,
  );
  relay.inject(room.roomId, blob);
  return id;
}

/** Close the room as its creator over a close-only connection. */
export async function closeTestRoom(
  relay: RelayHandle,
  room: TestRoom,
): Promise<void> {
  const once = await connectOnce({
    url: relay.url,
    hello: { t: "hello", room: room.roomId, proto: 1, closeOnly: true },
  });
  await once.close(
    await signClose(room.closeSecretKey, room.roomId, once.welcome.nonce),
  );
}

export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "agentroom-test-"));
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** Write room.json for a member into a temp home and start a session on it. */
export function startMember(
  home: string,
  relay: RelayHandle,
  room: TestRoom,
  member: string,
  agent: AgentName = "codex",
): RoomSession {
  writeRoomFile(home, {
    v: 1,
    roomId: room.roomId,
    secret: room.code,
    relay: relay.url,
    member,
    agent,
    createdByMe: false,
  });
  setCurrent(home, room.roomId);
  return createRoomSession({
    roomId: room.roomId,
    env: { AGENTROOM_HOME: home },
    backoff: { initialMs: 5, maxMs: 20 },
  });
}

export async function until(
  cond: () => boolean,
  ms = 5000,
  what = "condition",
): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect an MCP client to a server over the session, in process. */
export async function connectClient(session: RoomSession): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(session);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

export interface ToolText {
  text: string;
  isError: boolean;
  structured: Record<string, unknown> | undefined;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolText> {
  const r = await client.callTool({ name, arguments: args }, { signal });
  const content = r.content as { type: string; text?: string }[];
  return {
    text: content.map((c) => c.text ?? "").join("\n"),
    isError: r.isError === true,
    structured: r.structuredContent as Record<string, unknown> | undefined,
  };
}
