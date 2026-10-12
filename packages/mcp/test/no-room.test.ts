import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test } from "vitest";
import {
  createNoRoomServer,
  NO_ROOM_TEXT,
  roomToServe,
  writeRoomFile,
} from "../src/index.js";
import { makeHome, removeHome } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeHome(h);
});

test("the stub lists the five tools and the rules prompt, and every tool answers NO_ROOM_TEXT", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createNoRoomServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["handoff", "inbox", "room_status", "send", "wait"]);
  for (const name of names) {
    const r = await client.callTool({
      name,
      arguments: { kind: "fyi", body: "x" },
    });
    expect(r.isError).not.toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toBe(NO_ROOM_TEXT);
  }
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  expect(prompts).toEqual(["agentroom-rules"]);
  await client.close();
});

test("roomToServe: none without an id or when the room directory is gone, else the id", () => {
  const home = makeHome();
  homes.push(home);
  const env = { AGENTROOM_HOME: home };
  const id = "b".repeat(64);
  expect(roomToServe(undefined, env)).toBeUndefined();
  expect(roomToServe(id, env)).toBeUndefined();
  writeRoomFile(home, {
    v: 1,
    roomId: id,
    secret: "s",
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "codex",
    createdByMe: true,
  });
  expect(roomToServe(id, env)).toBe(id);
});
