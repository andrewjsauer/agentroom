import { existsSync, readFileSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { oneShot, readCurrent, readRoomFile, roomDir } from "@agentroom/mcp";
import {
  deriveRoom,
  generateCloseKeyPair,
  generateShareCode,
  parseShareCode,
} from "@agentroom/protocol";
import {
  type RelayEvent,
  type RelayHandle,
  startRelay,
} from "@agentroom/relay-node";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

let relay: RelayHandle;
let events: RelayEvent[];
const dirs: string[] = [];

beforeEach(async () => {
  events = [];
  relay = await startRelay({ port: 0, log: (e) => events.push(e) });
});

afterEach(async () => {
  await relay.close();
  for (const d of dirs.splice(0)) remove(d);
});

function home(): string {
  const h = tempDir();
  dirs.push(h);
  return h;
}

const mode = (p: string) => statSync(p).mode & 0o777;

test("up creates the room, writes room.json (0600) and current, and prints the code and join command", async () => {
  const h = home();
  const t = makeCtx(h);
  expect(
    await main(["up", "--relay", relay.url, "--name", "alice"], t.ctx),
  ).toBe(0);
  expect(t.err()).toBe("");

  const code = codeFrom(t.out());
  const { roomId } = deriveRoom(parseShareCode(code));
  expect(readCurrent(h)).toBe(roomId);
  expect(mode(joinPath(roomDir(h, roomId), "room.json"))).toBe(0o600);
  const room = readRoomFile(h, roomId);
  expect(room).toMatchObject({
    roomId,
    secret: code,
    relay: relay.url,
    member: "alice",
    agent: "other",
    createdByMe: true,
    projectDir: t.ctx.cwd,
  });
  expect(room.closeSecretKey).toBeDefined();
  expect(relay.snapshot(roomId)).toBeDefined();

  expect(t.out()).toContain(`agentroom join ${code} --relay ${relay.url}`);
  expect(t.out()).toContain(`Room id: ${roomId}`);
  expect(t.out()).toMatch(/Expires after 8 h without activity/);
  expect(t.out()).toContain(`mcp --room ${roomId}`);
});

test("up uses AGENTROOM_RELAY when --relay is absent and names it in the join command", async () => {
  const h = home();
  const t = makeCtx(h, { env: { AGENTROOM_RELAY: relay.url } });
  expect(await main(["up"], t.ctx)).toBe(0);
  const code = codeFrom(t.out());
  expect(t.out()).toContain(`agentroom join ${code} --relay ${relay.url}`);
  const t2 = makeCtx(home());
  // Only the default constant omits --relay; no relay runs there, so that branch has no test.
  expect(await main(["up", "--relay", relay.url], t2.ctx)).toBe(0);
  expect(t2.out()).toContain("--relay");
});

test("join writes room.json for the joiner with its own member and agent (no close key)", async () => {
  const hA = home();
  const a = makeCtx(hA);
  await main(["up", "--relay", relay.url], a.ctx);
  const code = codeFrom(a.out());
  const { roomId } = deriveRoom(parseShareCode(code));

  const hB = home();
  const b = makeCtx(hB);
  expect(
    await main(
      ["join", code, "--relay", relay.url, "--name", "bob", "--agent", "codex"],
      b.ctx,
    ),
  ).toBe(0);
  expect(b.err()).toBe("");
  expect(readCurrent(hB)).toBe(roomId);
  const room = readRoomFile(hB, roomId);
  expect(room).toMatchObject({
    roomId,
    secret: code,
    relay: relay.url,
    member: "bob",
    agent: "codex",
    createdByMe: false,
  });
  expect(room.closeSecretKey).toBeUndefined();
  expect(b.out()).toContain(`Joined room ${roomId} as bob (codex)`);
  expect(b.out()).toContain(
    "Agent chain limit: 3 per thread, 6 per room; hard ceiling 9/18 until you post.",
  );
  // Codex gets the user-scope adapter install (temp HOME), with no room id in the entry.
  const codexConfig = joinPath(hB, ".codex", "config.toml");
  expect(b.out()).toContain(`Updated ${codexConfig}`);
  expect(b.out()).toContain("Restart Codex");
  expect(readFileSync(codexConfig, "utf8")).not.toContain(roomId);
});

test("join on the creator's machine keeps the secret, close key and createdByMe", async () => {
  const h = home();
  const a = makeCtx(h);
  await main(["up", "--relay", relay.url, "--name", "alice"], a.ctx);
  const code = codeFrom(a.out());
  const { roomId } = deriveRoom(parseShareCode(code));
  const before = readRoomFile(h, roomId);
  const again = makeCtx(h);
  expect(
    await main(
      ["join", code, "--relay", relay.url, "--name", "al", "--agent", "gemini"],
      again.ctx,
    ),
  ).toBe(0);
  const after = readRoomFile(h, roomId);
  expect(after.closeSecretKey).toBe(before.closeSecretKey);
  expect(after.createdByMe).toBe(true);
  expect(after.member).toBe("al");
  expect(after.agent).toBe("gemini");
});

test("join with an unknown valid code prints not found and writes nothing (AE1)", async () => {
  const h = home();
  const t = makeCtx(h);
  const { code } = generateShareCode();
  expect(await main(["join", code, "--relay", relay.url], t.ctx)).toBe(1);
  expect(t.err()).toContain(`room not found on ${relay.url}`);
  expect(t.err()).toMatch(/expired, was closed, or the relay restarted/);
  expect(t.err()).toContain("--relay");
  expect(existsSync(joinPath(h, "rooms"))).toBe(false);
  expect(readCurrent(h)).toBeUndefined();
});

test("join with a bad code fails before any connection", async () => {
  const h = home();
  const t = makeCtx(h);
  expect(
    await main(["join", `ar2_${"A".repeat(43)}`, "--relay", relay.url], t.ctx),
  ).toBe(2);
  expect(t.err()).toContain("ar1_");
  expect(events.filter((e) => e.event === "conn_open")).toHaveLength(0);
  expect(existsSync(joinPath(h, "rooms"))).toBe(false);
});

test("join without a code refuses off a terminal and prompts on one", async () => {
  const hA = home();
  const a = makeCtx(hA);
  await main(["up", "--relay", relay.url], a.ctx);
  const code = codeFrom(a.out());

  const noTty = makeCtx(home());
  expect(await main(["join", "--relay", relay.url], noTty.ctx)).toBe(2);
  expect(noTty.err()).toContain("run in a terminal");

  const hB = home();
  const tty = makeCtx(hB, { isTTY: true });
  const run = main(["join", "--relay", relay.url, "--name", "bob"], tty.ctx);
  tty.stdin.write(`${code}\n`);
  expect(await run).toBe(0);
  expect(tty.out()).toContain("Share code: ");
  expect(readCurrent(hB)).toBeDefined();
});

test("join ends with a usage error when the prompt gets end of input", async () => {
  const tty = makeCtx(home(), { isTTY: true });
  const run = main(["join", "--relay", relay.url], tty.ctx);
  tty.stdin.end();
  expect(await run).toBe(2);
  expect(tty.err()).toContain("share code must start with ar1_");
});

test("up and join reject --agent human", async () => {
  const h = home();
  const u = makeCtx(h);
  expect(
    await main(["up", "--relay", relay.url, "--agent", "human"], u.ctx),
  ).toBe(2);
  expect(u.err()).toContain('invalid --agent "human"');
  const j = makeCtx(h);
  const { code } = generateShareCode();
  expect(
    await main(["join", code, "--relay", relay.url, "--agent", "human"], j.ctx),
  ).toBe(2);
  expect(events.filter((e) => e.event === "conn_open")).toHaveLength(0);
  expect(existsSync(joinPath(h, "rooms"))).toBe(false);
});

test("up against an unreachable relay prints an error and writes nothing", async () => {
  const h = home();
  const t = makeCtx(h);
  expect(await main(["up", "--relay", "ws://127.0.0.1:1"], t.ctx)).toBe(1);
  expect(t.err()).toMatch(/cannot reach relay/);
  expect(existsSync(joinPath(h, "rooms"))).toBe(false);
  expect(readCurrent(h)).toBeUndefined();
});

test("up --max-chain must be a whole number from 1 to 10", async () => {
  for (const bad of ["0", "11", "1000000", "2.5"]) {
    const t = makeCtx(home());
    expect(
      await main(["up", "--relay", relay.url, "--max-chain", bad], t.ctx),
    ).toBe(2);
    expect(t.err()).toContain(
      "--max-chain must be a whole number from 1 to 10",
    );
  }
  expect(events.filter((e) => e.event === "conn_open")).toHaveLength(0);
});

test("join prints the creator's chain limit and its hard ceiling", async () => {
  const a = makeCtx(home());
  expect(
    await main(["up", "--relay", relay.url, "--max-chain", "10"], a.ctx),
  ).toBe(0);
  const b = makeCtx(home());
  expect(
    await main(["join", codeFrom(a.out()), "--relay", relay.url], b.ctx),
  ).toBe(0);
  expect(b.out()).toContain(
    "Agent chain limit: 10 per thread, 20 per room; hard ceiling 30/60 until you post.",
  );
  expect(b.out()).not.toContain("caps it");
});

test("join clamps an older creator's out-of-range chain limit to 10 and says so", async () => {
  const { code, secret } = generateShareCode();
  const { roomId, key } = deriveRoom(secret);
  await sodium.ready;
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    JSON.stringify({ maxAgentChain: 1_000_000 }),
    roomId,
    null,
    nonce,
    key,
  );
  const meta = Buffer.concat([nonce, ct]).toString("base64");
  const { publicKey } = await generateCloseKeyPair();
  const res = await oneShot({
    url: relay.url,
    hello: {
      t: "hello",
      room: roomId,
      proto: 1,
      create: { closeKey: publicKey, meta },
    },
  });
  expect(res.t).toBe("welcome");

  const b = makeCtx(home());
  expect(await main(["join", code, "--relay", relay.url], b.ctx)).toBe(0);
  expect(b.out()).toContain(
    "The room asks for an agent chain limit of 1000000; agentroom caps it at 10.",
  );
  expect(b.out()).toContain(
    "Agent chain limit: 10 per thread, 20 per room; hard ceiling 30/60 until you post.",
  );
});

test("up --ttl sends maxAgeSec and prints the max-age deadline", async () => {
  const h = home();
  const two = makeCtx(h);
  expect(await main(["up", "--relay", relay.url, "--ttl", "2h"], two.ctx)).toBe(
    0,
  );
  const id2 = deriveRoom(parseShareCode(codeFrom(two.out()))).roomId;
  expect(relay.snapshot(id2)?.maxAgeSec).toBe(7200);

  const half = makeCtx(h);
  expect(
    await main(["up", "--relay", relay.url, "--ttl", "30m"], half.ctx),
  ).toBe(0);
  const id30 = deriveRoom(parseShareCode(codeFrom(half.out()))).roomId;
  expect(relay.snapshot(id30)?.maxAgeSec).toBe(1800);
  expect(half.out()).toMatch(/Expires in 30 min/);
  expect(half.out()).not.toContain("0 h");
  expect(half.out()).not.toContain("without activity");

  for (const bad of ["0h", "5", "1d"]) {
    const t = makeCtx(h);
    expect(await main(["up", "--relay", relay.url, "--ttl", bad], t.ctx)).toBe(
      2,
    );
  }
});
