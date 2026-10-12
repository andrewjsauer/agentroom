import {
  assertNoSecrets,
  chainRefusalText,
  chainState,
  checkChain,
  deriveRoom,
  Envelope,
  type ErrorCode,
  frameInbound,
  open,
  openMeta,
  parseShareCode,
  type Ref,
  resolveThread,
  seal,
  stripControl,
  ulid,
  waitingThreads,
} from "@agentroom/protocol";
import { agentroomHome } from "./paths.js";
import { writePending } from "./pending.js";
import {
  type ConnectionState,
  type GoneCode,
  RelayClient,
  type RelayClientOptions,
} from "./relay-client.js";
import {
  type AgentName,
  appendQueue,
  clearCurrentIf,
  deleteRoomDir,
  type QueueRecord,
  type RoomFile,
  readRoomFile,
  replayQueue,
  writeStatus,
} from "./state.js";

export const ROOM_EXPIRED_TEXT =
  "This room has expired or no longer exists on the relay (it may have restarted). Run `agentroom up` to start a new room.";
export const ROOM_CLOSED_TEXT =
  "The room was closed by its creator. Run `agentroom up` to start a new room.";
export const WAIT_CANCELLED_TEXT = "Wait cancelled; nothing was marked read.";

const ECHO_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_NAME_CHARS = 64;
const DEFAULT_MAX_AGENT_CHAIN = 3;

/** Non-terminal relay errors fail the oldest in-flight send with these texts (KTD13). */
const RELAY_ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  rate_limited:
    "The relay rate-limited this connection; wait a few seconds and send again.",
  too_large: "The relay refused the message as too large (64 KiB limit).",
  room_full:
    "The room is full (connection cap reached); the server keeps retrying.",
};

export type SendKind = "question" | "answer" | "decision" | "handoff" | "fyi";

export interface SendInput {
  kind: SendKind;
  body: string;
  refs?: Ref[];
  thread?: string;
  replyTo?: string;
  to?: string;
  requiresHuman?: boolean;
}

export interface MemberSeen {
  member: string;
  agent: string;
  lastSeen: number;
}

export interface RoomStatus {
  roomId: string;
  member: string;
  agent: string;
  relay: string;
  connection: ConnectionState;
  connections: number;
  /** Peer-supplied display names: control characters stripped and truncated, still untrusted. */
  membersSeen: MemberSeen[];
  unread: number;
  needsYou: number;
  decryptFailures: number;
  expiresAt: number | null;
  /** Threads at or over the chain limit; thread ids are peer-chosen and untrusted. */
  waitingOnHuman: { thread: string; count: number }[];
  /** Consecutive agent messages across threads, against the room-wide limit (2N). */
  roomAgentRun: { count: number; limit: number };
}

/**
 * The only `from` this server ever emits (invariant 2): the room's configured agent.
 * `via` is "mcp" for posts and "hook" for drafts, which the M3 hook releases unchanged.
 */
function buildFrom(
  room: RoomFile,
  via: "mcp" | "hook" = "mcp",
): { member: string; agent: AgentName; via: "mcp" | "hook" } {
  return { member: room.member, agent: room.agent, via };
}

/** Invariant 2 runtime guard, applied to every post and draft. */
function refuseHuman(env: Envelope): void {
  if ((env.from.agent as string) === "human") {
    throw new Error("the MCP server never sends as a human");
  }
}

/** Peer-controlled display strings are stripped of control characters and bounded before display. */
function sanitizeName(s: string): string {
  return stripControl(s).slice(0, MAX_NAME_CHARS);
}

export interface RoomSession {
  readonly roomId: string;
  /** Loaded room.json; mutable only so the invariant 2 guard can be tested. */
  room: RoomFile;
  status(): RoomStatus;
  send(input: SendInput): Promise<{ id: string; seq: number }>;
  /** Resolve the thread, scan, and write pending.json instead of posting (KTD16). No chain check. */
  draft(input: SendInput): { env: Envelope; hash: string };
  inbox(opts?: { thread?: string; limit?: number }): string;
  /** Resolves with framed messages, a timeout notice, or the cancel notice when `signal` aborts. */
  wait(timeoutSec: number, signal?: AbortSignal): Promise<string>;
  readonly gone: boolean;
  close(): void;
}

export function createRoomSession(opts: {
  roomId: string;
  env: NodeJS.ProcessEnv;
  backoff?: RelayClientOptions["backoff"];
}): RoomSession {
  const home = agentroomHome(opts.env);
  const roomId = opts.roomId;
  const room = readRoomFile(home, roomId);
  const { key } = deriveRoom(parseShareCode(room.secret));
  const replay = replayQueue(home, roomId);
  const history = replay.history;
  const seen = replay.seen;
  const unread = replay.unread;
  let lastSeq = replay.lastSeq;
  const members = new Map<string, MemberSeen>();
  let connections = 0;
  let decryptFailures = 0;
  let expiresAt: number | null = null;
  let ttlMs = 0;
  let gone = false;
  let goneCode: GoneCode = "room_expired";
  let maxAgentChain = DEFAULT_MAX_AGENT_CHAIN;
  /** Settles once the latest welcome's meta is read and its backlog is in `history` (KTD14). */
  let ready: Promise<void> = Promise.resolve();
  let processedSeq = 0;
  let catchUp: { head: number; resolve(): void } | undefined;
  let closed = false;
  let finalReadDone = false;
  let presenceSent = false;
  const pendingEcho = new Map<
    string,
    { resolve(seq: number): void; reject(err: Error): void }
  >();
  const waiters = new Set<() => void>();
  let sendChain: Promise<unknown> = Promise.resolve();

  const noteMember = (env: Envelope) => {
    const member = sanitizeName(env.from.member);
    const agent = sanitizeName(env.from.agent);
    members.set(`${member}/${agent}`, { member, agent, lastSeen: env.ts });
  };
  for (const m of history) noteMember(m.env);

  const isNeedsYou = (env: Envelope) =>
    env.requiresHuman || env.to === session.room.member;

  const goneText = () =>
    goneCode === "closed" ? ROOM_CLOSED_TEXT : ROOM_EXPIRED_TEXT;

  /** History in relay seq order: live arrivals and replayed lines can interleave. */
  const ordered = () =>
    [...history].sort((a, b) => a.seq - b.seq).map((m) => m.env);

  const unreadMessages = () =>
    history.filter((m) => unread.has(m.env.id)).sort((a, b) => a.seq - b.seq);

  const status = (): RoomStatus => {
    const u = unreadMessages();
    const chain = chainState(ordered(), maxAgentChain);
    return {
      roomId,
      member: session.room.member,
      agent: session.room.agent,
      relay: session.room.relay,
      connection: gone ? "gone" : client.state,
      connections: gone ? 0 : connections,
      membersSeen: [...members.values()],
      unread: u.length,
      needsYou: u.filter((m) => isNeedsYou(m.env)).length,
      decryptFailures,
      expiresAt,
      waitingOnHuman: waitingThreads(chain).map((w) => ({
        thread: sanitizeName(w.thread),
        count: w.count,
      })),
      roomAgentRun: { count: chain.room, limit: 2 * maxAgentChain },
    };
  };

  const persistStatus = () => {
    if (gone) return;
    const s = status();
    writeStatus(home, roomId, {
      connection: s.connection,
      connections: s.connections,
      members: s.membersSeen,
      unread: s.unread,
      needsYou: s.needsYou,
      decryptFailures,
      expiresAt,
      lastSeq,
      updatedAt: Date.now(),
    });
  };

  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  /** The single seal path for outbound envelopes. Refuses a human tag (invariant 2). */
  const sealOutbound = (env: Envelope): Promise<string> => {
    refuseHuman(env);
    return seal(env, key, roomId);
  };

  const post = async (env: Envelope): Promise<number> => {
    const blob = await sealOutbound(env);
    const echo = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingEcho.delete(env.id);
        reject(new Error("The relay did not confirm the message in time."));
      }, ECHO_TIMEOUT_MS);
      pendingEcho.set(env.id, {
        resolve: (seq) => {
          clearTimeout(timer);
          resolve(seq);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    try {
      await client.put(blob);
    } catch (err) {
      pendingEcho.get(env.id)?.reject(err as Error);
      pendingEcho.delete(env.id);
    }
    return echo;
  };

  const onMsg = async (seq: number, blob: string) => {
    let env: Envelope;
    try {
      env = await open(blob, key, roomId);
    } catch {
      decryptFailures++;
      persistStatus();
      return;
    }
    if (gone) return;
    lastSeq = Math.max(lastSeq, seq);
    if (ttlMs > 0) expiresAt = Date.now() + ttlMs;
    const pending = pendingEcho.get(env.id);
    if (!pending && seen.has(env.id)) {
      persistStatus();
      return;
    }
    const own = pending !== undefined;
    seen.add(env.id);
    history.push({ seq, env, own });
    const record: QueueRecord = { t: "msg", seq, env, own };
    appendQueue(home, roomId, [record]);
    noteMember(env);
    if (pending) {
      pendingEcho.delete(env.id);
      pending.resolve(seq);
    } else if (env.kind !== "presence") {
      unread.add(env.id);
      wake();
    }
    persistStatus();
  };

  /** Release `send` once inbound processing reaches the welcome head, or at once when `force`. */
  const settleCatchUp = (force: boolean) => {
    if (catchUp && (force || processedSeq >= catchUp.head)) {
      catchUp.resolve();
      catchUp = undefined;
    }
  };

  const onGone = (code: GoneCode) => {
    gone = true;
    goneCode = code;
    client.stop();
    deleteRoomDir(home, roomId);
    clearCurrentIf(home, roomId);
    for (const p of pendingEcho.values()) p.reject(new Error(goneText()));
    pendingEcho.clear();
    wake();
  };

  /** Fail the oldest in-flight send (sends are serialized, so it caused the error). */
  const onError = (code: ErrorCode) => {
    const text = RELAY_ERROR_TEXT[code];
    const oldest = pendingEcho.entries().next();
    if (text === undefined || oldest.done) return;
    const [id, p] = oldest.value;
    pendingEcho.delete(id);
    p.reject(new Error(text));
  };

  const client = new RelayClient({
    url: room.relay,
    roomId,
    initialSince: 0,
    backoff: opts.backoff,
    onWelcome: (w) => {
      catchUp?.resolve();
      const caughtUp = new Promise<void>((resolve) => {
        catchUp = { head: w.seq, resolve };
      });
      settleCatchUp(false);
      const meta = openMeta(w.meta, key, roomId).then(
        (m) => {
          maxAgentChain = m.maxAgentChain;
        },
        () => {
          decryptFailures++;
          process.stderr.write(
            "agentroom: room settings did not decrypt; using the default chain limit\n",
          );
        },
      );
      ready = Promise.all([meta, caughtUp]).then(() => {});
      connections = w.members;
      expiresAt = w.expiresAt;
      ttlMs = w.expiresAt - Date.now();
      persistStatus();
      if (!presenceSent) {
        presenceSent = true;
        const id = ulid();
        post(
          Envelope.parse({
            v: 1,
            id,
            ts: Date.now(),
            from: buildFrom(session.room),
            kind: "presence",
            thread: id,
            body: "",
          }),
        ).catch((err: Error) => {
          if (!closed && !gone) {
            process.stderr.write(
              `agentroom: presence not sent: ${err.message}\n`,
            );
          }
        });
      }
    },
    onMsg: (seq, blob) => {
      onMsg(seq, blob)
        .catch((err: Error) => {
          process.stderr.write(
            `agentroom: inbound message not processed: ${err.message}\n`,
          );
        })
        .finally(() => {
          processedSeq = Math.max(processedSeq, seq);
          settleCatchUp(false);
        });
    },
    onPresence: (n) => {
      connections = n;
      persistStatus();
    },
    onGone,
    onError,
    onState: (state) => {
      if (state !== "live") settleCatchUp(true);
      persistStatus();
    },
  });

  /** Gone check, thread resolution (KTD2), then the envelope with the non-human `from`. */
  const build = (input: SendInput, via: "mcp" | "hook"): Envelope => {
    if (gone) throw new Error(goneText());
    const id = ulid();
    const thread = resolveThread(
      { id, thread: input.thread, replyTo: input.replyTo },
      ordered(),
    );
    return Envelope.parse({
      v: 1,
      id,
      ts: Date.now(),
      from: buildFrom(session.room, via),
      kind: input.kind,
      thread,
      replyTo: input.replyTo,
      to: input.to,
      body: input.body,
      refs: input.refs ?? [],
      requiresHuman: input.requiresHuman ?? false,
    });
  };

  const inbox = (o: { thread?: string; limit?: number } = {}): string => {
    if (gone && finalReadDone) return goneText();
    const all = unreadMessages().filter(
      (m) => o.thread === undefined || m.env.thread === o.thread,
    );
    const batch = all.slice(0, o.limit ?? DEFAULT_LIMIT);
    const parts: string[] = [];
    if (batch.length > 0) {
      for (const m of batch) unread.delete(m.env.id);
      if (!gone) {
        appendQueue(home, roomId, [
          { t: "read", ids: batch.map((m) => m.env.id) },
        ]);
        persistStatus();
      }
      parts.push(frameInbound(batch.map((m) => m.env)));
      const more = all.length - batch.length;
      if (more > 0) parts.push(`${more} more unread.`);
    } else if (!gone) {
      parts.push("No unread messages.");
    }
    if (gone) {
      finalReadDone = true;
      parts.push(goneText());
    }
    return parts.join("\n");
  };

  const session: RoomSession = {
    roomId,
    room,
    status,
    get gone() {
      return gone;
    },
    inbox,
    send(input) {
      const run = async () => {
        await ready;
        const env = build(input, "mcp");
        const refusal = checkChain(
          chainState(ordered(), maxAgentChain),
          env.thread,
        );
        if (refusal) throw new Error(chainRefusalText(refusal));
        const seq = await post(env);
        return { id: env.id, seq };
      };
      const result = sendChain.then(run, run);
      sendChain = result.catch(() => {});
      return result;
    },
    draft(input) {
      const env = build(input, "hook");
      refuseHuman(env);
      assertNoSecrets(env);
      return { env, hash: writePending(home, roomId, env) };
    },
    async wait(timeoutSec, signal) {
      if (gone || unreadMessages().length > 0) return inbox();
      if (signal?.aborted) return WAIT_CANCELLED_TEXT;
      const outcome = await new Promise<"arrived" | "timeout" | "aborted">(
        (resolve) => {
          const finish = (o: "arrived" | "timeout" | "aborted") => {
            clearTimeout(timer);
            waiters.delete(done);
            signal?.removeEventListener("abort", onAbort);
            resolve(o);
          };
          const timer = setTimeout(() => finish("timeout"), timeoutSec * 1000);
          const done = () => finish("arrived");
          const onAbort = () => finish("aborted");
          waiters.add(done);
          signal?.addEventListener("abort", onAbort, { once: true });
        },
      );
      if (outcome === "arrived") return inbox();
      if (outcome === "aborted") return WAIT_CANCELLED_TEXT;
      return `No new messages in ${timeoutSec}s.`;
    },
    close() {
      closed = true;
      client.stop();
      settleCatchUp(true);
      for (const p of pendingEcho.values()) {
        p.reject(new Error("The session is closing."));
      }
      pendingEcho.clear();
      wake();
    },
  };

  client.start();
  return session;
}
