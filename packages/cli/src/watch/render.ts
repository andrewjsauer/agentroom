import { stripTerminal } from "../safe-text.js";
import { threads, type WatchModel } from "./model.js";

/** The renderer's own highlights; peer text never carries escapes (it is stripped). */
const BOLD = "\u001b[1m";
const INVERSE = "\u001b[7m";
const RESET = "\u001b[0m";
const BODY_INDENT = "    ";

/** Cut to `cols` code points. */
const fit = (s: string, cols: number) => [...s].slice(0, cols).join("");

/** Hard-wrap to `width` code points; an empty line stays one empty line. */
function wrap(s: string, width: number): string[] {
  const chars = [...s];
  if (chars.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) {
    out.push(chars.slice(i, i + width).join(""));
  }
  return out;
}

/**
 * The whole screen as lines (KTD19): header, numbered thread list with markers, the selected
 * thread's latest messages that fit, an optional notice, and the input line last. Pure.
 */
export function renderWatch(
  model: WatchModel,
  view: {
    cols: number;
    rows: number;
    selected: number;
    input: string;
    notice?: string;
  },
): string[] {
  const cols = Math.max(view.cols, 10);
  const rows = Math.max(view.rows, 4);
  const list = threads(model);
  const lines: string[] = [];
  lines.push(
    `${BOLD}${fit(`agentroom * room ${model.roomId.slice(0, 8)} * ${model.connections} connected * you are ${stripTerminal(model.me)}`, cols)}${RESET}`,
  );

  const listRows = Math.min(list.length, Math.max(1, Math.floor(rows / 3)));
  if (list.length === 0) lines.push(fit("No messages yet.", cols));
  for (let i = 0; i < listRows; i++) {
    const t = list[i];
    if (!t) break;
    const marks = [
      t.needsYou ? "needs you" : "",
      t.limited ? `waiting on a human (${t.chain})` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const first = stripTerminal(t.messages[0]?.body.split("\n")[0] ?? "");
    const text = fit(
      `${i + 1}. ${marks ? `[${marks}] ` : ""}${first || "(no text)"}`,
      cols,
    );
    lines.push(i === view.selected ? `${INVERSE}${text}${RESET}` : text);
  }
  if (list.length > listRows) {
    lines.push(fit(`... ${list.length - listRows} more thread(s)`, cols));
  }
  lines.push("-".repeat(cols));

  const footer: string[] = [];
  if (view.notice) footer.push(fit(stripTerminal(view.notice), cols));
  footer.push(fit(`> ${view.input}`, cols));

  const space = rows - lines.length - footer.length;
  const thread = list[view.selected];
  const body: string[] = [];
  if (thread) {
    for (const env of thread.messages) {
      const who = `${stripTerminal(env.from.member)}/${stripTerminal(env.from.agent)}`;
      const flag = env.requiresHuman ? " [requires human]" : "";
      body.push(...wrap(`${who} ${env.kind}${flag}:`, cols));
      for (const line of env.body.split("\n")) {
        for (const part of wrap(
          stripTerminal(line),
          cols - BODY_INDENT.length,
        )) {
          body.push(`${BODY_INDENT}${part}`);
        }
      }
    }
  }
  if (space > 0) lines.push(...body.slice(Math.max(0, body.length - space)));
  return [...lines.slice(0, rows - footer.length), ...footer];
}
