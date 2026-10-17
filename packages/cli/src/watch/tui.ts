import { createInterface } from "node:readline";
import {
  agentroomHome,
  type GoneCode,
  RelayClient,
  ROOM_CLOSED_TEXT,
} from "@agentroom/mcp";
import {
  deriveRoom,
  type EnvelopeInput,
  open,
  openMeta,
  parseShareCode,
  ulid,
} from "@agentroom/protocol";
import { sayTarget } from "../commands/say.js";
import { type CliContext, forgetGoneRoom, loadRoom } from "../context.js";
import {
  HUMAN_MESSAGE_REASON,
  humanFrom,
  requireHumanTerminal,
} from "../human.js";
import { checkRelayUrl } from "../relay-url.js";
import { connectForPost } from "../room-post.js";
import { stripTerminal } from "../safe-text.js";
import { applyEnvelope, emptyModel, parseInput, threads } from "./model.js";
import { renderWatch } from "./render.js";

const CLEAR = "\u001b[H\u001b[2J";

type Screen = NodeJS.WritableStream & { columns?: number; rows?: number };

/**
 * `agentroom watch` (KTD19): its own relay connection, in-memory model, full redraw on change
 * and resize, readline input posted as human messages with `via: "watch"`. Never writes
 * queue.jsonl, never marks read, sends no presence.
 */
export async function runWatch(
  roomFlag: string | undefined,
  ctx: CliContext,
): Promise<number> {
  requireHumanTerminal(ctx, { stdout: true, reason: HUMAN_MESSAGE_REASON });
  const home = agentroomHome(ctx.env);
  const { roomId, room } = loadRoom(roomFlag, ctx);
  checkRelayUrl(room.relay, "room.json");
  const { key } = deriveRoom(parseShareCode(room.secret));
  const screen = ctx.stdout as Screen;
  let model = emptyModel(roomId, room.member);
  // Follows the latest thread until the user picks one; then pinned by id, because threads
  // reorder by recency and an index would move a reply or approve to another thread.
  let selectedId: string | undefined;
  let notice: string | undefined;

  const draw = () => {
    const list = threads(model);
    const lines = renderWatch(model, {
      cols: screen.columns ?? 80,
      rows: screen.rows ?? 24,
      selected:
        selectedId === undefined
          ? 0
          : list.findIndex((t) => t.id === selectedId),
      input: "",
      notice,
    });
    screen.write(`${CLEAR}${lines.join("\n")}`);
  };

  return new Promise<number>((resolve) => {
    let done = false;
    const rl = createInterface({ input: ctx.stdin, terminal: false });
    const finish = (code: number, text?: string) => {
      if (done) return;
      done = true;
      client.stop();
      rl.close();
      screen.off?.("resize", draw);
      if (text) screen.write(`\n${text}\n`);
      resolve(code);
    };

    const client = new RelayClient({
      url: room.relay,
      roomId,
      initialSince: 0,
      onWelcome: (w) => {
        model = { ...model, connections: w.members };
        openMeta(w.meta, key, roomId).then(
          (m) => {
            model = { ...model, maxAgentChain: m.maxAgentChain };
            draw();
          },
          () => {},
        );
        draw();
      },
      onMsg: (seq, blob) => {
        open(blob, key, roomId).then(
          (env) => {
            model = applyEnvelope(model, seq, env);
            draw();
          },
          () => {}, // Undecryptable: nothing to show.
        );
      },
      onPresence: (n) => {
        model = { ...model, connections: n };
        draw();
      },
      onGone: (code: GoneCode) => {
        if (code === "closed") {
          finish(1, ROOM_CLOSED_TEXT);
          return;
        }
        finish(1, forgetGoneRoom(home, roomId, room.relay));
      },
    });

    const post = async (
      build: (history: Parameters<typeof sayTarget>[0]) => EnvelopeInput,
    ) => {
      const s = await connectForPost(roomFlag, ctx);
      try {
        await s.post(build(s.history));
      } finally {
        s.end();
      }
    };

    rl.on("line", (line) => {
      const list = threads(model);
      const input = parseInput(line, list.length);
      const thread = selectedId ?? list[0]?.id;
      const id = ulid();
      let action: Promise<void> | undefined;
      notice = undefined;
      switch (input.t) {
        case "quit":
          finish(0);
          return;
        case "none":
          break;
        case "error":
          notice = input.message;
          break;
        case "select":
          selectedId = list[input.index]?.id;
          break;
        case "new":
          action = post(() => ({
            v: 1,
            id,
            ts: Date.now(),
            from: humanFrom(room, "watch"),
            kind: "question",
            thread: id,
            body: input.text,
          }));
          selectedId = id;
          break;
        case "reply":
        case "approve":
          if (thread === undefined) {
            notice = "No thread yet; use /new <text>.";
            break;
          }
          action = post((history) => {
            if (input.t === "approve") {
              return {
                v: 1,
                id,
                ts: Date.now(),
                from: humanFrom(room, "watch"),
                kind: "approve",
                thread,
                body: "",
              };
            }
            const target = sayTarget(history, id, { thread, isNew: false });
            return {
              v: 1,
              id,
              ts: Date.now(),
              from: humanFrom(room, "watch"),
              kind: "answer",
              thread: target.thread,
              replyTo: target.replyTo,
              body: input.text,
            };
          });
          break;
      }
      action?.catch((err: Error) => {
        notice = `Not sent: ${stripTerminal(err.message)}`;
        draw();
      });
      draw();
    });
    rl.on("close", () => finish(0));
    screen.on?.("resize", draw);
    client.start();
    draw();
  });
}
