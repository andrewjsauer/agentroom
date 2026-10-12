import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendQueue,
  createRoomSession,
  draftHash,
  type RoomSession,
  roomDir,
} from "@agentroom/mcp";
import type { Envelope } from "@agentroom/protocol";
import { afterEach, expect, test } from "vitest";
import { type HookRoom, hookRoom, reasonOf } from "./hook-env.js";

let r: HookRoom;
const sessions: RoomSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await r.close();
});

const pendingPath = () => join(roomDir(r.home, r.roomId), "pending.json");
const send = (args: string) =>
  r.expand({
    command_name: "agentroom:send",
    command_args: args,
    prompt: `/agentroom:send ${args}`,
  });

async function setup(opts: Parameters<typeof hookRoom>[0] = {}) {
  r = await hookRoom(opts);
  const q = await r.agentPost();
  const session = createRoomSession({
    roomId: r.roomId,
    env: { AGENTROOM_HOME: r.home, AGENTROOM_NOTIFY: "off" },
  });
  sessions.push(session);
  const end = Date.now() + 5000;
  while (session.status().unread < 1) {
    if (Date.now() > end) throw new Error("session did not catch up");
    await new Promise((res) => setTimeout(res, 5));
  }
  return { session, q };
}

/** Rewrite pending.json with a changed envelope and, optionally, a recomputed hash. */
function tamper(change: (env: Envelope) => void, rehash: boolean) {
  const file = JSON.parse(readFileSync(pendingPath(), "utf8"));
  change(file.env);
  if (rehash) file.hash = draftHash(file.env);
  writeFileSync(pendingPath(), JSON.stringify(file));
  return file.hash as string;
}

test("AE2: a replaced draft refuses the old hash; the new hash posts the draft then a human approve", async () => {
  const { session, q } = await setup();
  const h1 = session.draft({
    kind: "answer",
    body: "first",
    replyTo: q.id,
  }).hash;
  const d2 = session.draft({
    kind: "answer",
    body: "second\nline",
    replyTo: q.id,
  });
  const before = r.head();
  const stale = await send(h1);
  expect(reasonOf(stale.out)).toBe(
    `Not sent: the pending draft changed after it was shown (now ${d2.hash}). Ask Claude to show it again, or type /agentroom:send to preview it.`,
  );
  expect(r.head()).toBe(before);

  const ok = await send(d2.hash.toUpperCase());
  const [draft, approve] = (await r.all()).slice(-2) as [Envelope, Envelope];
  expect(draft).toEqual(d2.env);
  expect(draft.from).toEqual({ member: "alice", agent: "other", via: "hook" });
  expect(approve).toMatchObject({
    kind: "approve",
    thread: q.thread,
    from: { member: "alice", agent: "human", via: "hook" },
  });
  expect(existsSync(pendingPath())).toBe(false);
  expect(reasonOf(ok.out)).toBe(
    `Sent draft ${d2.hash} to room ${r.roomId.slice(0, 8)} (thread ${q.thread.slice(0, 8)}) and approved the thread as alice (human). Sent text: second\nline`,
  );
  // The release recorded both ids as sent before the puts: the draft is own, the human approve
  // stays unread for the agent (M3 KTD14).
  const end = Date.now() + 5000;
  while (session.status().unread < 2) {
    if (Date.now() > end) throw new Error("approve not seen");
    await new Promise((res) => setTimeout(res, 5));
  }
  const lines = readFileSync(
    join(roomDir(r.home, r.roomId), "queue.jsonl"),
    "utf8",
  ).split("\n");
  const sentAt = lines.findIndex(
    (l) => l.includes('"t":"sent"') && l.includes(draft.id),
  );
  const msgAt = lines.findIndex(
    (l) => l.includes('"t":"msg"') && l.includes(draft.id),
  );
  expect(sentAt).toBeGreaterThanOrEqual(0);
  expect(sentAt).toBeLessThan(msgAt);
  expect(lines[msgAt]).toContain('"own":true');
  expect(session.status().unread).toBe(2);
  expect(session.inbox()).not.toContain("second");
});

test("AE3: an envelope edited after hashing is refused and the file kept", async () => {
  const { session } = await setup();
  const { hash } = session.draft({ kind: "fyi", body: "shown" });
  tamper((env) => {
    env.body = "swapped";
  }, false);
  const before = r.head();
  expect(reasonOf((await send(hash)).out)).toMatch(
    /^Not sent: the pending draft changed/,
  );
  expect(r.head()).toBe(before);
  expect(existsSync(pendingPath())).toBe(true);
});

test("hand-edited drafts with a recomputed hash are refused: human, other member, via mcp, approve", async () => {
  const { session } = await setup();
  const edits: ((env: Envelope) => void)[] = [
    (env) => {
      env.from.agent = ["hu", "man"].join("");
    },
    (env) => {
      env.from.member = "bob";
    },
    (env) => {
      env.from.via = "mcp";
    },
    (env) => {
      env.kind = "approve";
    },
  ];
  const before = r.head();
  for (const edit of edits) {
    session.draft({ kind: "fyi", body: "x" });
    const hash = tamper(edit, true);
    expect(reasonOf((await send(hash)).out)).toBe(
      "Not sent: the pending draft is not an agent draft from this member.",
    );
  }
  expect(r.head()).toBe(before);
});

test("a draft whose id is already in the room is refused as already sent", async () => {
  const { session } = await setup();
  const { hash } = session.draft({ kind: "fyi", body: "once" });
  const saved = readFileSync(pendingPath(), "utf8");
  await send(hash);
  writeFileSync(pendingPath(), saved);
  const before = r.head();
  expect(reasonOf((await send(hash)).out)).toBe(
    "Not sent: this draft was already sent.",
  );
  expect(r.head()).toBe(before);
  // The local queue alone is enough to know too.
  const env = JSON.parse(saved).env;
  appendQueue(r.home, r.roomId, [{ t: "msg", seq: 999, env, own: true }]);
  expect(reasonOf((await send(hash)).out)).toBe(
    "Not sent: this draft was already sent.",
  );
});

test("send with no argument previews from disk: stripped, newlines kept, truncated at 1,500", async () => {
  const { session } = await setup();
  const body = `top\u001b[31m\nnext‮ ${"z".repeat(2000)}`;
  const { env, hash } = session.draft({ kind: "question", body });
  const reason = reasonOf((await send("")).out);
  const lines = reason.split("\n");
  expect(lines[0]).toBe(
    `Pending draft ${hash} (question, thread ${env.thread.slice(0, 8)}):`,
  );
  expect(lines[1]).toBe("top");
  expect(lines[2]?.startsWith("next z")).toBe(true);
  expect(reason).toContain("[truncated]");
  expect(lines.at(-1)).toBe(`Type /agentroom:send ${hash} to send it.`);
});

test("no pending draft, and a malformed hash", async () => {
  const { session } = await setup();
  expect(reasonOf((await send("")).out)).toBe("Not sent: no draft is pending.");
  expect(reasonOf((await send("abc")).out)).toBe(
    "Not sent: no draft is pending.",
  );
  session.draft({ kind: "fyi", body: "x" });
  expect(reasonOf((await send("xyz")).out)).toMatch(
    /^Not sent: the pending draft changed/,
  );
});

test("a draft in a thread at the chain limit is released, and the approve lets the agent send again", async () => {
  const { session, q } = await setup();
  await r.agentPost({ thread: q.thread });
  await r.agentPost({ thread: q.thread });
  const until = Date.now() + 5000;
  while (session.status().unread < 3) {
    if (Date.now() > until) throw new Error("posts not seen");
    await new Promise((res) => setTimeout(res, 5));
  }
  await expect(
    session.send({ kind: "answer", body: "no", thread: q.thread }),
  ).rejects.toThrow(/needs a human/);
  const { hash } = session.draft({
    kind: "answer",
    body: "ok",
    thread: q.thread,
  });
  expect(reasonOf((await send(hash)).out)).toMatch(/^Sent draft/);
  const end = Date.now() + 5000;
  for (;;) {
    try {
      await session.send({ kind: "answer", body: "again", thread: q.thread });
      break;
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((res) => setTimeout(res, 20));
    }
  }
});

test("a refused approve reports the partial result; the draft slot is cleared", async () => {
  const { session } = await setup({ rateLimit: { burst: 1, perSec: 0.001 } });
  const { env, hash } = session.draft({ kind: "fyi", body: "x" });
  const reason = reasonOf((await send(hash)).out);
  expect(reason).toMatch(
    new RegExp(
      `^Sent draft ${hash}, but the approval was not sent: .+\\. Run /agentroom:approve ${env.thread.slice(0, 8)} to retry\\.$`,
    ),
  );
  expect(existsSync(pendingPath())).toBe(false);
});
