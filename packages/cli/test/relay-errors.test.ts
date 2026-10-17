import { setCurrent, writeRoomFile } from "@agentroom/mcp";
import { generateShareCode } from "@agentroom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

/** An OSC 52 clipboard write, a CSI colour and a BEL: what a hostile relay might send. */
const EVIL = "boom\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[31mred\u0007";

const relayMock = vi.hoisted(() => ({
  oneShot: vi.fn(),
  connectOnce: vi.fn(),
}));

vi.mock("@agentroom/mcp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@agentroom/mcp")>();
  relayMock.connectOnce.mockImplementation(async () => {
    throw new real.RelayError("rate_limited", EVIL);
  });
  return {
    ...real,
    oneShot: relayMock.oneShot,
    connectOnce: relayMock.connectOnce,
  };
});

relayMock.oneShot.mockResolvedValue({
  t: "error",
  code: "rate_limited",
  message: EVIL,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});

function clean(text: string): void {
  expect(text).toContain("boom");
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\u0007");
}

function homeWithRoom(): string {
  const home = tempDir();
  dirs.push(home);
  const roomId = "f".repeat(64);
  writeRoomFile(home, {
    v: 1,
    roomId,
    secret: generateShareCode().code,
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "other",
    createdByMe: true,
    closeSecretKey: "k",
  });
  setCurrent(home, roomId);
  return home;
}

test("up, join and status strip escapes from a relay error message", async () => {
  const home = tempDir();
  dirs.push(home);
  const up = makeCtx(home);
  expect(await main(["up", "--relay", "ws://127.0.0.1:1"], up.ctx)).toBe(1);
  clean(up.err());

  const join = makeCtx(home);
  const code = generateShareCode().code;
  expect(
    await main(["join", code, "--relay", "ws://127.0.0.1:1"], join.ctx),
  ).toBe(1);
  clean(join.err());

  const status = makeCtx(homeWithRoom());
  expect(await main(["status"], status.ctx)).toBe(1);
  clean(status.err());
});

test("a RelayError thrown on reconnect (say, down) is stripped before it is printed", async () => {
  const home = homeWithRoom();
  const say = makeCtx(home, { isTTY: true, stdoutIsTTY: true });
  expect(await main(["say", "hi"], say.ctx)).toBe(1);
  clean(say.err());
  const down = makeCtx(home);
  expect(await main(["down"], down.ctx)).toBe(1);
  clean(down.err());
});
