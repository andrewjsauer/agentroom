import { z } from "zod";

/** A code reference. Each side reads its own checkout (invariant 6: no file contents). */
export const Ref = z.object({
  repo: z.string(),
  path: z.string(),
  lines: z.string().optional(),
  commit: z.string().optional(),
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

/** Plaintext message envelope, before encryption (docs/ARCHITECTURE.md "Message envelope"). */
export const Envelope = z.object({
  v: z.literal(1),
  id: z.string(),
  ts: z.number(),
  from: z.object({
    member: z.string(),
    agent: z.string(),
    via: z.enum(["mcp", "hook", "watch", "cli"]),
  }),
  kind: EnvelopeKind,
  thread: z.string(),
  replyTo: z.string().optional(),
  to: z.string().optional(),
  body: z.string().max(8_000),
  refs: z.array(Ref).max(20).default([]),
  requiresHuman: z.boolean().default(false),
});
export type Envelope = z.infer<typeof Envelope>;
export type EnvelopeInput = z.input<typeof Envelope>;
