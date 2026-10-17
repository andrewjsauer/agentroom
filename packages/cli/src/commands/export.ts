import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentroomHome, replayQueue, roomDir } from "@agentroom/mcp";
import { type Envelope, isoTime, refText } from "@agentroom/protocol";
import { type CliContext, CliError, resolveRoomId } from "../context.js";
import { requireHumanTerminal } from "../human.js";
import { safeBody, safeLine } from "../safe-text.js";

const NO_HISTORY =
  "No local history for this room: it was closed or expired, or no MCP server ran here.";

const longestRun = (s: string) =>
  Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));

/** An inline code span whose delimiter outruns any backtick run in the value. */
function codeSpan(value: string): string {
  const fence = "`".repeat(longestRun(value) + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced block longer than any backtick run inside it. */
function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** POSIX sh single quoting. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Markdown where every peer string is neutralized: names and ids in code spans, bodies fenced (KTD23). */
function render(
  roomId: string,
  date: string,
  messages: { seq: number; env: Envelope }[],
): string {
  const threads = new Map<string, { seq: number; env: Envelope }[]>();
  for (const m of messages) {
    const list = threads.get(m.env.thread) ?? [];
    list.push(m);
    threads.set(m.env.thread, list);
  }
  const out = [
    `# agentroom export: room ${codeSpan(roomId.slice(0, 12))} (${date})`,
  ];
  for (const [thread, list] of threads) {
    out.push("", `## Thread ${codeSpan(safeLine(thread))}`);
    for (const { seq, env } of list) {
      const who = codeSpan(safeLine(`${env.from.member}/${env.from.agent}`));
      const human = env.from.agent === "human" ? " (human)" : "";
      out.push(
        "",
        `**seq ${seq}, ${isoTime(env.ts)}, ${who}${human}, ${env.kind}**`,
        "",
        fenced(
          safeBody(
            [env.body, ...env.refs.map((r) => `refs: ${refText(r)}`)].join(
              "\n",
            ),
          ),
        ),
      );
    }
  }
  return `${out.join("\n")}\n`;
}

/** Export the local queue only; no relay connection (KTD23). */
export async function exportRoom(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  requireHumanTerminal(ctx, {
    stdout: false,
    reason:
      "Exporting decrypted messages must be done by you in your own terminal.",
  });
  const format = values.format ?? "md";
  if (format !== "md" && format !== "gh-issue") {
    throw new CliError("--format must be md or gh-issue", 2);
  }
  const home = agentroomHome(ctx.env);
  const roomId = resolveRoomId(values.room, ctx);
  if (roomId === undefined || !existsSync(roomDir(home, roomId))) {
    throw new CliError(NO_HISTORY);
  }
  let messages = replayQueue(home, roomId)
    .history.filter((m) => m.env.kind !== "presence")
    .sort((a, b) => a.seq - b.seq);
  if (values.thread !== undefined) {
    const thread = values.thread;
    messages = messages.filter((m) => m.env.thread === thread);
    if (messages.length === 0) {
      throw new CliError(
        `thread ${safeLine(thread)} is not in the local history`,
      );
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const md = render(roomId, date, messages);
  if (format === "md") {
    ctx.stdout.write(md);
    return 0;
  }
  const dir = mkdtempSync(
    join(ctx.env.TMPDIR || tmpdir(), "agentroom-export-"),
  );
  chmodSync(dir, 0o700);
  const path = join(dir, "issue.md");
  writeFileSync(path, md, { mode: 0o600 });
  ctx.stdout.write(
    [
      `Wrote the issue body to ${path}. It holds decrypted messages; delete it when done.`,
      "Run:",
      `gh issue create --title ${shellQuote(`agentroom export ${date}`)} --body-file ${shellQuote(path)}`,
      "",
    ].join("\n"),
  );
  return 0;
}
