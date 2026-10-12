import {
  type ErrorCode,
  type ErrorFrame,
  type HelloFrame,
  PROTOCOL_VERSION,
  RelayFrame,
  roomUrl,
  type WelcomeFrame,
} from "@agentroom/protocol";
import WebSocket from "ws";

export type ConnectionState = "connecting" | "live" | "backoff" | "gone";
export type GoneCode = "room_not_found" | "room_expired" | "closed";

export interface RelayClientOptions {
  url: string;
  roomId: string;
  initialSince: number;
  onWelcome(welcome: WelcomeFrame): void;
  onMsg(seq: number, blob: string): void;
  onPresence(members: number): void;
  onGone(code: GoneCode): void;
  /** Every relay error except the terminal ones (KTD13). */
  onError?(code: ErrorCode, message: string): void;
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
    const ws = new WebSocket(roomUrl(this.opts.url, this.opts.roomId));
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
          this.opts.onError?.(frame.code, frame.message);
        }
        break;
      case "closed":
        this.setState("gone");
        this.stop();
        this.opts.onGone("closed");
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
    const ws = new WebSocket(roomUrl(opts.url, opts.hello.room));
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

/** A relay error frame surfaced as an exception; `code` is the relay's error code. */
export class RelayError extends Error {
  override name = "RelayError";
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OnceSession {
  welcome: WelcomeFrame;
  /** With `since` in the hello: every buffered `msg` up to `welcome.seq`. */
  msgs: { seq: number; blob: string }[];
  /** Post an opaque blob; resolves with the seq of its echo. */
  put(blob: string): Promise<number>;
  /** Send `close`; resolves on `closed`. */
  close(sig: string): Promise<void>;
  end(): void;
}

/**
 * One-shot relay session for CLI senders (KTD19). Handles opaque blobs only; it never
 * builds an envelope. Resolves after the welcome and, when the hello has `since`, once the
 * `msg` with seq `welcome.seq` (the head) has arrived.
 */
export function connectOnce(opts: {
  url: string;
  hello: HelloFrame;
  timeoutMs?: number;
}): Promise<OnceSession> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(roomUrl(opts.url, opts.hello.room));
    const msgs: { seq: number; blob: string }[] = [];
    let welcome: WelcomeFrame | undefined;
    let ready = false;
    let pending:
      | {
          match(f: RelayFrame): boolean;
          resolve(f: RelayFrame): void;
          reject(e: Error): void;
        }
      | undefined;
    let timer = setTimeout(
      () => fail(new Error(`relay at ${opts.url} did not answer`)),
      timeoutMs,
    );
    const end = () => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    };
    const fail = (e: Error) => {
      end();
      if (!ready) rejectConnect(e);
      else pending?.reject(e);
      pending = undefined;
    };
    const session: OnceSession = {
      get welcome() {
        return welcome as WelcomeFrame;
      },
      msgs,
      put(blob) {
        return wait(
          (f) => f.t === "msg" && f.blob === blob,
          () => ws.send(JSON.stringify({ t: "put", blob })),
        ).then((f) => (f as { seq: number }).seq);
      },
      close(sig) {
        return wait(
          (f) => f.t === "closed",
          () => ws.send(JSON.stringify({ t: "close", sig })),
        ).then(() => end());
      },
      end,
    };
    const wait = (
      match: (f: RelayFrame) => boolean,
      act: () => void,
    ): Promise<RelayFrame> =>
      new Promise((resolve, reject) => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(new Error(`relay at ${opts.url} did not confirm`)),
          timeoutMs,
        );
        pending = { match, resolve, reject };
        act();
      });
    const finishCatchUp = () => {
      ready = true;
      clearTimeout(timer);
      resolveConnect(session);
    };
    ws.on("open", () => ws.send(JSON.stringify(opts.hello)));
    ws.on("message", (data) => {
      let f: RelayFrame;
      try {
        f = RelayFrame.parse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (f.t === "error") {
        fail(new RelayError(f.code, f.message));
        return;
      }
      if (!ready) {
        if (f.t === "welcome") {
          welcome = f;
          if (opts.hello.since === undefined || f.seq <= opts.hello.since) {
            finishCatchUp();
          }
        } else if (f.t === "msg" && welcome) {
          msgs.push({ seq: f.seq, blob: f.blob });
          if (f.seq >= welcome.seq) finishCatchUp();
        }
        return;
      }
      if (pending?.match(f)) {
        const p = pending;
        pending = undefined;
        clearTimeout(timer);
        p.resolve(f);
      }
    });
    ws.on("error", (err) =>
      fail(new Error(`cannot reach relay at ${opts.url}: ${err.message}`)),
    );
    ws.on("close", () =>
      fail(new Error(`relay at ${opts.url} closed the connection`)),
    );
  });
}
