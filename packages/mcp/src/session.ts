import {
  deriveRoom,
  Envelope,
  frameInbound,
  open,
  parseShareCode,
  type Ref,
  seal,
  stripControl,
  ulid,
} from "@agentroom/protocol";
import { agentroomHome } from "./paths.js";
import {
  type ConnectionState,
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
  type StoredMessage,
  writeStatus,
} from "./state.js";

export const ROOM_EXPIRED_TEXT =
  "This room has expired or no longer exists on the relay (it may have restarted). Run `agentroom up` to start a new room.";
export const WAIT_CANCELLED_TEXT = "Wait cancelled; nothing was marked read.";

const ECHO_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_NAME_CHARS = 64;

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
}

/** The only `from` this server ever emits (invariant 2): the room's configured agent, via mcp. */
export function buildFrom(room: RoomFile): {
  member: string;
  agent: AgentName;
  via: "mcp";
} {
  return { member: room.member, agent: room.agent, via: "mcp" };
}

/** Peer-controlled display strings are stripped of control characters and bounded before display. */
export function sanitizeName(s: string): string {
  return stripControl(s).slice(0, MAX_NAME_CHARS);
}

/** M1 send policy: allow everything. M2 adds the chain limit and secret scanner here. */
function sendPolicy(_env: Envelope, _history: StoredMessage[]): void {}

export interface RoomSession {
  readonly roomId: string;
  /** Loaded room.json; mutable only so the invariant 2 guard can be tested. */
  room: RoomFile;
  status(): RoomStatus;
  send(input: SendInput): Promise<{ id: string; seq: number }>;
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
    members.set(member, {
      member,
      agent: sanitizeName(env.from.agent),
      lastSeen: env.ts,
    });
  };
  for (const m of history) noteMember(m.env);

  const isNeedsYou = (env: Envelope) =>
    env.requiresHuman || env.to === session.room.member;

  const unreadMessages = () =>
    history.filter((m) => unread.has(m.env.id)).sort((a, b) => a.seq - b.seq);

  const status = (): RoomStatus => {
    const u = unreadMessages();
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
    if ((env.from.agent as string) === "human") {
      throw new Error("the MCP server never sends as a human");
    }
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

  const onGone = () => {
    gone = true;
    client.stop();
    deleteRoomDir(home, roomId);
    clearCurrentIf(home, roomId);
    for (const p of pendingEcho.values())
      p.reject(new Error(ROOM_EXPIRED_TEXT));
    pendingEcho.clear();
    wake();
  };

  const client = new RelayClient({
    url: room.relay,
    roomId,
    initialSince: 0,
    backoff: opts.backoff,
    onWelcome: (w) => {
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
          if (!closed) {
            process.stderr.write(
              `agentroom: presence not sent: ${err.message}\n`,
            );
          }
        });
      }
    },
    onMsg: (seq, blob) => {
      void onMsg(seq, blob);
    },
    onPresence: (n) => {
      connections = n;
      persistStatus();
    },
    onGone,
    onState: () => persistStatus(),
  });

  const inbox = (o: { thread?: string; limit?: number } = {}): string => {
    if (gone && finalReadDone) return ROOM_EXPIRED_TEXT;
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
      parts.push(ROOM_EXPIRED_TEXT);
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
        if (gone) throw new Error(ROOM_EXPIRED_TEXT);
        const id = ulid();
        const parent = input.replyTo
          ? history.find((m) => m.env.id === input.replyTo)
          : undefined;
        const thread =
          input.thread ?? parent?.env.thread ?? input.replyTo ?? id;
        const env = Envelope.parse({
          v: 1,
          id,
          ts: Date.now(),
          from: buildFrom(session.room),
          kind: input.kind,
          thread,
          replyTo: input.replyTo,
          to: input.to,
          body: input.body,
          refs: input.refs ?? [],
          requiresHuman: input.requiresHuman ?? false,
        });
        sendPolicy(env, history);
        const seq = await post(env);
        return { id, seq };
      };
      const result = sendChain.then(run, run);
      sendChain = result.catch(() => {});
      return result;
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
