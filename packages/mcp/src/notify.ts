import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type Envelope, stripControl } from "@agentroom/protocol";

/** Raise one desktop notification; never throws. */
export type Notifier = (title: string, text: string) => void;

export type Spawner = (command: string, args: string[]) => void;

const PREVIEW_CHARS = 80;
const NAME_CHARS = 32;

/** Locate an executable by scanning PATH directories; no shell is involved. */
export function findOnPath(
  path: string | undefined,
  name: string,
): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Detached, no shell, output ignored, errors swallowed. */
const spawnDetached: Spawner = (command, args) => {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A missing command is not worth surfacing.
  }
};

const escapeMarkup = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Pick the notifier once (KTD16). Peer text only ever travels as separate argv entries: on macOS
 * the AppleScript source is three fixed lines reading `argv`; on Linux `notify-send` gets the
 * text after `--` with markup characters escaped. Elsewhere, or with AGENTROOM_NOTIFY=off, no-op.
 */
export function createNotifier(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn?: Spawner;
}): Notifier {
  const run = opts.spawn ?? spawnDetached;
  if (opts.env.AGENTROOM_NOTIFY === "off") return () => {};
  if (opts.platform === "darwin") {
    return (title, text) =>
      run("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        text,
      ]);
  }
  if (opts.platform === "linux") {
    const bin = findOnPath(opts.env.PATH, "notify-send");
    if (bin === undefined) return () => {};
    return (title, text) =>
      run(bin, [
        "--app-name=agentroom",
        "--",
        escapeMarkup(title),
        escapeMarkup(text),
      ]);
  }
  return () => {};
}

/** Title and preview for a message that needs this member, stripped of control characters. */
export function notificationText(env: Envelope): {
  title: string;
  text: string;
} {
  const member = stripControl(env.from.member).slice(0, NAME_CHARS);
  const title = env.requiresHuman
    ? `agentroom: ${member} needs you`
    : `agentroom: ${env.kind} for you from ${member}`;
  const text = stripControl(env.body.replace(/\s+/g, " "))
    .trim()
    .slice(0, PREVIEW_CHARS);
  return { title, text };
}

/** One message reads as `notificationText`; several coalesce into a count and the latest preview. */
export function batchNotificationText(envs: Envelope[]): {
  title: string;
  text: string;
} {
  const latest = notificationText(envs[envs.length - 1] as Envelope);
  if (envs.length === 1) return latest;
  return {
    title: `agentroom: ${envs.length} new messages need you`,
    text: latest.text,
  };
}
