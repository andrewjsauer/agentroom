import { z } from "zod";

/** The largest time a JS Date can hold, in ms since the epoch. */
export const MAX_TIME_MS = 8.64e15;

/** A wall-clock time in ms that `new Date(ms).toISOString()` can always format. */
export const TimeMs = z.number().int().min(0).max(MAX_TIME_MS);

/** ISO 8601 for a time in ms, or "unknown" for null, non-finite or out-of-range values. */
export function isoTime(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
  if (ms < 0 || ms > MAX_TIME_MS) return "unknown";
  return new Date(ms).toISOString();
}

/** Upper bounds for envelope strings; the schema applies on send and on receive. */
export const ENVELOPE_LIMITS = {
  id: 64,
  name: 64,
  repo: 128,
  path: 512,
  lines: 64,
  commit: 64,
} as const;

/** A repo-relative path: no leading slash or backslash, no drive letter, no `..` segment. */
export function isRepoRelative(path: string): boolean {
  if (/^[/\\]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[/\\]/).includes("..");
}

/** A code reference. Each side reads its own checkout (invariant 6: no file contents). */
export const Ref = z.object({
  repo: z.string().max(ENVELOPE_LIMITS.repo),
  path: z
    .string()
    .max(ENVELOPE_LIMITS.path)
    .refine(isRepoRelative, "ref path must be relative to the repo root"),
  lines: z.string().max(ENVELOPE_LIMITS.lines).optional(),
  commit: z.string().max(ENVELOPE_LIMITS.commit).optional(),
});
export type Ref = z.infer<typeof Ref>;

export const EnvelopeKind = z.enum([
  "question",
  "answer",
  "decision",
  "handoff",
  "fyi",
  "approve",
  "presence",
]);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

const Id = z.string().max(ENVELOPE_LIMITS.id);
const Name = z.string().max(ENVELOPE_LIMITS.name);

/** Plaintext message envelope, before encryption (docs/ARCHITECTURE.md "Message envelope"). */
export const Envelope = z.object({
  v: z.literal(1),
  id: Id,
  ts: TimeMs,
  from: z.object({
    member: Name,
    agent: Name,
    via: z.enum(["mcp", "hook", "watch", "cli"]),
  }),
  kind: EnvelopeKind,
  thread: Id,
  replyTo: Id.optional(),
  to: Name.optional(),
  body: z.string().max(8_000),
  refs: z.array(Ref).max(20).default([]),
  requiresHuman: z.boolean().default(false),
});
export type Envelope = z.infer<typeof Envelope>;
export type EnvelopeInput = z.input<typeof Envelope>;
