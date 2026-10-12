import {
  type ErrorFrame,
  type HelloFrame,
  PROTOCOL_VERSION,
  RelayFrame,
  type WelcomeFrame,
} from "@agentroom/protocol";
import WebSocket from "ws";

export type ConnectionState = "connecting" | "live" | "backoff" | "gone";
export type GoneCode = "room_not_found" | "room_expired";

export interface RelayClientOptions {
  url: string;
  roomId: string;
  initialSince: number;
  onWelcome(welcome: WelcomeFrame): void;
  onMsg(seq: number, blob: string): void;
  onPresence(members: number): void;
  onGone(code: GoneCode): void;
  onState?(state: ConnectionState): void;
  backoff?: { initialMs?: number; maxMs?: number };
}

function log(message: string): void {
  process.stderr.write(`agentroom: ${message}\n`);
}

/** Full-jitter exponential backoff: random in [0, min(max, initial * 2^attempt)). */
export function backoffDelay(
  attempt: number,
  initialMs = 500,
  maxMs = 30_000,
  random: () => number = Math.random,
): number {
  return random() * Math.min(maxMs, initialMs * 2 ** attempt);
}

/** Long-lived relay connection that reconnects with backoff and resumes from the last seq. */
export class RelayClient {
  state: ConnectionState = "connecting";
  private since: number;
  private ws: WebSocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: RelayClientOptions) {
    this.since = opts.initialSince;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.terminate();
  }

  put(blob: string): Promise<void> {
    const ws = this.ws;
    if (this.state !== "live" || !ws) {
      return Promise.reject(
        new Error("The relay is unreachable; reconnecting. Try again shortly."),
      );
    }
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ t: "put", blob }), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.opts.onState?.(state);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on("open", () => {
      const hello: HelloFrame = {
        t: "hello",
        room: this.opts.roomId,
        proto: PROTOCOL_VERSION,
        since: this.since,
      };
      ws.send(JSON.stringify(hello));
    });
    ws.on("message", (data) => this.onFrame(data.toString()));
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws !== ws || this.stopped || this.state === "gone") return;
      this.setState("backoff");
      const { initialMs, maxMs } = this.opts.backoff ?? {};
      const delay = backoffDelay(this.attempt++, initialMs, maxMs);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  private onFrame(raw: string): void {
    let frame: RelayFrame;
    try {
      frame = RelayFrame.parse(JSON.parse(raw));
    } catch {
      log("ignored a malformed relay frame");
      return;
    }
    switch (frame.t) {
      case "welcome":
        this.attempt = 0;
        this.setState("live");
        this.opts.onWelcome(frame);
        break;
      case "msg":
        this.since = Math.max(this.since, frame.seq);
        this.opts.onMsg(frame.seq, frame.blob);
        break;
      case "presence":
        this.opts.onPresence(frame.members);
        break;
      case "error":
        if (frame.code === "room_not_found" || frame.code === "room_expired") {
          this.setState("gone");
          this.stop();
          this.opts.onGone(frame.code);
        } else {
          log(`relay error ${frame.code}: ${frame.message}`);
        }
        break;
      case "closed":
        break;
    }
  }
}

/** Connect once, send a hello, and return the first welcome or error. */
export function oneShot(opts: {
  url: string;
  hello: HelloFrame;
  timeoutMs?: number;
}): Promise<WelcomeFrame | ErrorFrame> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`relay at ${opts.url} did not answer`));
    }, opts.timeoutMs ?? 10_000);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      fn();
    };
    ws.on("open", () => ws.send(JSON.stringify(opts.hello)));
    ws.on("message", (data) => {
      let parsed: ReturnType<typeof RelayFrame.safeParse>;
      try {
        parsed = RelayFrame.safeParse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const f = parsed.data;
      if (f.t === "welcome" || f.t === "error") finish(() => resolve(f));
    });
    ws.on("error", (err) =>
      finish(() =>
        reject(new Error(`cannot reach relay at ${opts.url}: ${err.message}`)),
      ),
    );
    ws.on("close", () =>
      finish(() =>
        reject(new Error(`relay at ${opts.url} closed the connection`)),
      ),
    );
  });
}
