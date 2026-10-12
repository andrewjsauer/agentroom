const START = "<!-- agentroom:start -->";
const END = "<!-- agentroom:end -->";

/** The UX.md instruction for agents that only read messages when they call a tool. */
export const SNIPPET =
  "This project uses agentroom. At the start of each task and after finishing each step, call the `inbox` tool. When you are waiting on the other team, call `wait`.";

function find(text: string): { start: number; end: number } | undefined {
  // Pair the end marker with the nearest start before it, so a stray start keeps the text after it.
  const close = text.indexOf(END);
  if (close < 0) return undefined;
  const start = text.lastIndexOf(START, close);
  if (start < 0) return undefined;
  let end = close + END.length;
  if (text[end] === "\n") end++;
  return { start, end };
}

/** Replace the marker block, or append it after one blank line; idempotent. */
export function upsertBlock(text: string, body = SNIPPET): string {
  const block = `${START}\n${body}\n${END}\n`;
  const at = find(text);
  if (at) return text.slice(0, at.start) + block + text.slice(at.end);
  const base = text.replace(/\n+$/, "");
  return base === "" ? block : `${base}\n\n${block}`;
}

/** Remove the marker block; "" when nothing else was in the file. */
export function removeBlock(text: string): string {
  const at = find(text);
  if (!at) return text;
  const before = text.slice(0, at.start);
  const after = text.slice(at.end);
  const rest =
    after.trim() === "" ? before.replace(/\n+$/, "\n") : before + after;
  return rest.trim() === "" ? "" : rest;
}
