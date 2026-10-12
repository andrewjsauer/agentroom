import type { Ref } from "@agentroom/protocol";

export const HANDOFF_MAX_CHARS = 8_000;

export interface HandoffInput {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  refs: Ref[];
}

const bullets = (items: string[]) =>
  items.length === 0 ? ["- None"] : items.map((i) => `- ${i}`);

function refLine(ref: Ref): string {
  let s = `- ${ref.repo}/${ref.path}`;
  if (ref.lines !== undefined) s += `:${ref.lines}`;
  if (ref.commit !== undefined) s += ` @ ${ref.commit}`;
  return s;
}

/** Compose a handoff body from the fixed template (KTD15). Throws when it exceeds the body limit. */
export function renderHandoff(h: HandoffInput): string {
  const body = [
    "## Summary",
    h.summary,
    "",
    "## Decisions",
    ...bullets(h.decisions),
    "",
    "## Open questions",
    ...bullets(h.openQuestions),
    "",
    "## Refs",
    ...(h.refs.length === 0 ? ["- None"] : h.refs.map(refLine)),
  ].join("\n");
  if (body.length > HANDOFF_MAX_CHARS) {
    throw new Error(
      `The composed handoff is ${body.length} characters; the limit is ${HANDOFF_MAX_CHARS}. Shorten the summary or lists.`,
    );
  }
  return body;
}
