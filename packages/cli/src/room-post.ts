import {
  agentroomHome,
  connectOnce,
  RelayError,
  type RoomFile,
  replayQueue,
} from "@agentroom/mcp";
import {
  deriveRoom,
  type Envelope,
  type EnvelopeInput,
  open,
  parseShareCode,
  seal,
} from "@agentroom/protocol";
import {
  type CliContext,
  CliError,
  forgetGoneRoom,
  loadRoom,
} from "./context.js";

export interface PostSession {
  room: RoomFile;
  /** Relay replay merged with the local queue, deduped by id, in seq order (KTD20). */
  history: Envelope[];
  /** Seal (which scans for secrets) and post; resolves with the echo seq. */
  post(env: EnvelopeInput): Promise<number>;
  end(): void;
}

/** A one-shot session for a CLI sender. The CLI never writes queue.jsonl. */
export async function connectForPost(
  roomFlag: string | undefined,
  ctx: CliContext,
): Promise<PostSession> {
  const home = agentroomHome(ctx.env);
  const { roomId, room } = loadRoom(roomFlag, ctx);
  const { key } = deriveRoom(parseShareCode(room.secret));
  let once: Awaited<ReturnType<typeof connectOnce>>;
  try {
    once = await connectOnce({
      url: room.relay,
      hello: { t: "hello", room: roomId, proto: 1, since: 0 },
    });
  } catch (err) {
    if (
      err instanceof RelayError &&
      (err.code === "room_not_found" || err.code === "room_expired")
    ) {
      throw new CliError(forgetGoneRoom(home, roomId, room.relay));
    }
    throw err;
  }
  const byId = new Map<string, { seq: number; env: Envelope }>();
  for (const m of replayQueue(home, roomId).history) {
    byId.set(m.env.id, { seq: m.seq, env: m.env });
  }
  for (const m of once.msgs) {
    try {
      const env = await open(m.blob, key, roomId);
      byId.set(env.id, { seq: m.seq, env });
    } catch {
      // Undecryptable blobs are dropped.
    }
  }
  const history = [...byId.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((m) => m.env);
  return {
    room,
    history,
    async post(env) {
      return once.put(await seal(env, key, roomId));
    },
    end: () => once.end(),
  };
}
