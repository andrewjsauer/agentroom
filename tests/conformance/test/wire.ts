import { randomBytes } from "node:crypto";
import WebSocket from "ws";

// biome-ignore lint/suspicious/noExplicitAny: raw relay frames in tests
export type Frame = any;

export const newRoomId = () => randomBytes(32).toString("hex");

/** A raw WebSocket client that queues frames so tests can take them in order. */
export class Conn {
  readonly frames: Frame[] = [];
  closed = false;
  closeCode = 0;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(String(d))));
    ws.on("close", (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    ws.on("error", () => {});
  }

  static open(relay: string, room?: string): Promise<Conn> {
    const url = room ? `${relay}/?room=${room}` : relay;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new Conn(ws)));
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
      ws.once("error", reject);
    });
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Remove and return the first queued frame matching `t` (and `pred`), waiting up to `ms`. */
  async take(t: string, pred: (f: Frame) => boolean = () => true, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex((f) => f.t === t && pred(f));
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (Date.now() > end) {
        throw new Error(
          `no ${t} frame within ${ms} ms; queued: ${JSON.stringify(this.frames).slice(0, 300)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitClosed(ms = 8000): Promise<number> {
    const end = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > end) throw new Error("connection did not close");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closeCode;
  }

  close(): void {
    this.ws.terminate();
  }
}
