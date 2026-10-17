import { setCurrent, writeRoomFile } from "@agentroom/mcp";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { checkRelayUrl, resolveRelay } from "../src/relay-url.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});

test("wss:// is accepted for any host; ws:// only for loopback", () => {
  for (const url of [
    "wss://relay.example.com",
    "wss://relay.example.com:8443/path",
    "ws://localhost:8787",
    "ws://127.0.0.1:8787",
    "ws://[::1]:8787",
  ]) {
    expect(checkRelayUrl(url, "--relay")).toBe(url);
  }
});

test("other schemes and non-loopback ws:// are refused with the source named", () => {
  for (const url of [
    "ws://relay.example.com",
    "ws://127.0.0.2:8787",
    "ws://localhost.evil.example",
    "http://127.0.0.1:8787",
    "https://relay.example.com",
    "file:///etc/passwd",
    "not a url",
  ]) {
    expect(() => checkRelayUrl(url, "AGENTROOM_RELAY")).toThrow(
      /refusing relay URL .* from AGENTROOM_RELAY: use wss:\/\//,
    );
  }
  expect(() => resolveRelay("http://x", {})).toThrow(/from --relay/);
  expect(() =>
    resolveRelay(undefined, { AGENTROOM_RELAY: "ws://relay.example.com" }),
  ).toThrow(/from AGENTROOM_RELAY/);
});

test("the refusal strips terminal escapes from the URL", () => {
  let message = "";
  try {
    checkRelayUrl("ws://x\u001b]52;c;Zm9v\u0007", "--relay");
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("refusing relay URL");
  expect(message).not.toContain("\u001b");
  expect(message).not.toContain("\u0007");
});

test("up and join refuse a non-wss relay before any connection and write nothing", async () => {
  const home = tempDir();
  dirs.push(home);
  const up = makeCtx(home);
  expect(await main(["up", "--relay", "ws://relay.example.com"], up.ctx)).toBe(
    1,
  );
  expect(up.err()).toContain("refusing relay URL");
  const join = makeCtx(home, {
    env: { AGENTROOM_RELAY: "http://relay.example.com" },
  });
  expect(await main(["join", `ar1_${"A".repeat(43)}`], join.ctx)).toBe(1);
  expect(join.err()).toContain("from AGENTROOM_RELAY");
});

test("reconnecting commands refuse a room.json relay that is not wss:// or loopback", async () => {
  const home = tempDir();
  dirs.push(home);
  const roomId = "e".repeat(64);
  writeRoomFile(home, {
    v: 1,
    roomId,
    secret: "ar1_x",
    relay: "ws://relay.example.com",
    member: "alice",
    agent: "other",
    createdByMe: true,
    closeSecretKey: "k",
  });
  setCurrent(home, roomId);
  for (const argv of [["status"], ["down"]]) {
    const t = makeCtx(home);
    expect(await main(argv, t.ctx)).toBe(1);
    expect(t.err()).toContain("from room.json");
  }
  for (const argv of [["say", "hi"], ["approve", "t"], ["watch"]]) {
    const t = makeCtx(home, { isTTY: true, stdoutIsTTY: true });
    expect(await main(argv, t.ctx)).toBe(1);
    expect(t.err()).toContain("from room.json");
  }
});
