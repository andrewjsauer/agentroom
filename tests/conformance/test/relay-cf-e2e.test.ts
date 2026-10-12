import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_CLOSED_TEXT } from "@agentroom/mcp";
import {
  deriveRoom,
  FRAME_REMINDER,
  parseShareCode,
} from "@agentroom/protocol";
import type { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CF_SKIP, CF_TITLE, type CfRelay, startCfRelay } from "./cf-helpers.js";
import { baseEnv, call, cli, closeAll, connectMcp, until } from "./helpers.js";

describe.skipIf(CF_SKIP)(`${CF_TITLE}: CLI and MCP end to end`, () => {
  let cf: CfRelay;
  const homes: string[] = [];
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];

  beforeAll(async () => {
    cf = await startCfRelay();
  }, 60_000);
  afterAll(async () => {
    await closeAll(clients, transports);
    await cf?.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  test("question and answer travel framed through relay-cf; down closes the room for the peer", async () => {
    const env = () => {
      const h = mkdtempSync(join(tmpdir(), "agentroom-cf-"));
      homes.push(h);
      return baseEnv(h, cf.url);
    };
    const envA = env();
    const envB = env();
    const out = await cli(envA, ["up", "--name", "alice", "--agent", "codex"]);
    const code = out
      .split("\n")
      .find((l) => l.startsWith("ar1_"))
      ?.trim() as string;
    const { roomId } = deriveRoom(parseShareCode(code));
    await cli(envB, ["join", code, "--name", "bob", "--agent", "gemini"]);
    const alice = await connectMcp(envA, roomId, transports);
    const bob = await connectMcp(envB, roomId, transports);
    clients.push(alice, bob);

    const q = `question-${Math.random().toString(16).slice(2)}`;
    expect(
      (await call(alice, "send", { kind: "question", body: q })).isError,
    ).toBe(false);
    const got = await call(bob, "wait", { timeoutSec: 20 });
    expect(got.text).toContain(q);
    expect(got.text).toContain(FRAME_REMINDER);
    const qid = /thread="([^"]+)"/.exec(got.text)?.[1];

    const a = `answer-${Math.random().toString(16).slice(2)}`;
    expect(
      (await call(bob, "send", { kind: "answer", body: a, replyTo: qid }))
        .isError,
    ).toBe(false);
    const inbox = await until(async () => {
      const r = await call(alice, "inbox");
      return r.text.includes(a) ? r.text : undefined;
    }, "alice inbox");
    expect(inbox).toContain(FRAME_REMINDER);
    expect(inbox).not.toContain(q);

    expect(await cli(envA, ["down"])).toContain("closed; local state removed");
    await until(async () => {
      const r = await call(bob, "inbox");
      return r.text.includes(ROOM_CLOSED_TEXT) ? true : undefined;
    }, "bob sees the room closed");
  }, 60_000);
});
