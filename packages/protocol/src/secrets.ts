import type { EnvelopeInput } from "./envelope.js";

interface Rule {
  name: string;
  re: RegExp;
  explanation: string;
}

/**
 * Credential rules ported from gitleaks config/gitleaks.toml (inline `(?i)` rewritten as
 * whole-regex flags, which Node 20 requires) plus the git-secrets AWS secret pattern.
 * Sources and porting notes: docs/OPEN_QUESTIONS.md.
 */
const RULES: Rule[] = [
  {
    name: "aws-access-key-id",
    re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/,
    explanation: "It matches the shape of an AWS access key id.",
  },
  {
    name: "aws-secret-access-key",
    re: /(?:aws)?_?(?:secret)?_?(?:access)?_?key["']?\s*(?::|=>|=)\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
    explanation: "It looks like an AWS secret access key assignment.",
  },
  {
    name: "github-pat",
    re: /\bghp_[0-9a-zA-Z]{36}\b/,
    explanation: "It matches a GitHub personal access token.",
  },
  {
    name: "github-oauth",
    re: /\bgho_[0-9a-zA-Z]{36}\b/,
    explanation: "It matches a GitHub OAuth token.",
  },
  {
    name: "github-app-token",
    re: /\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\b/,
    explanation: "It matches a GitHub app token.",
  },
  {
    name: "github-refresh-token",
    re: /\bghr_[0-9a-zA-Z]{36}\b/,
    explanation: "It matches a GitHub refresh token.",
  },
  {
    name: "github-fine-grained-pat",
    re: /\bgithub_pat_\w{82}\b/,
    explanation: "It matches a GitHub fine-grained personal access token.",
  },
  {
    name: "slack-token",
    re: /\bxox[baprseo]-[0-9A-Za-z-]{10,}/,
    explanation: "It matches a Slack token.",
  },
  {
    name: "slack-app-token",
    re: /\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/i,
    explanation: "It matches a Slack app-level token.",
  },
  {
    name: "private-key",
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/,
    explanation: "It contains a private key header.",
  },
  {
    name: "jwt",
    re: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?/,
    explanation: "It matches a JSON Web Token.",
  },
  {
    name: "gcp-api-key",
    re: /\bAIza[\w-]{35}(?![\w-])/,
    explanation: "It matches a Google Cloud API key.",
  },
  {
    name: "stripe-live-key",
    re: /\b[sr]k_live_[A-Za-z0-9]{10,}/,
    explanation: "It matches a live Stripe key.",
  },
];

/** Keyword assignment with a high-entropy value (KTD24). Name in group 1, value in group 2. */
const GENERIC =
  /([A-Za-z0-9_]{0,30}(?:key|token|secret|passwd|password)[A-Za-z0-9_]{0,20})["']?\s*(?::\s*[A-Za-z_][\w.<>?]*\s*)?(?:=>|:=|=|:)\s*["']?([A-Za-z0-9_\-+/=.~]{20,150})(?![A-Za-z0-9_\-+/=.~])/gi;
const GENERIC_NAME_ALLOW =
  /(?:alias|url|uri|length|len|size|name|id|header|field|type|provider|path|file)$|^csrf/i;
const GENERIC_EXPLANATION =
  "It looks like a key, token, secret or password assigned a random-looking value.";

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function genericMatch(text: string): boolean {
  for (const m of text.matchAll(GENERIC)) {
    const name = m[1] as string;
    const value = m[2] as string;
    if (!/\d/.test(value)) continue;
    const parts = value.split(/[_.-]/);
    if (
      parts.length > 1 &&
      parts.every(
        (p) => /^[A-Za-z]+$/.test(p) || /^[A-Za-z]{0,2}\d{1,6}$/.test(p),
      )
    ) {
      continue;
    }
    if (shannonEntropy(value) <= 3.5) continue;
    if (GENERIC_NAME_ALLOW.test(name)) continue;
    return true;
  }
  return false;
}

/** A blocked send. Carries the rule and field, never the matched text. */
export class SecretFoundError extends Error {
  override name = "SecretFoundError";
  constructor(
    readonly rule: string,
    readonly field: string,
    readonly explanation: string,
  ) {
    super(
      `Blocked: this message looks like it contains a secret (rule ${rule}, in ${field}). ${explanation} Remove it and send again.`,
    );
  }
}

function scanText(
  text: string,
): { rule: string; explanation: string } | undefined {
  for (const r of RULES) {
    if (r.re.test(text)) return { rule: r.name, explanation: r.explanation };
  }
  if (genericMatch(text)) {
    return { rule: "generic-assignment", explanation: GENERIC_EXPLANATION };
  }
  return undefined;
}

/** Scan the body, `to`, and every ref field (invariant 4); throws SecretFoundError on the first match. */
export function assertNoSecrets(env: EnvelopeInput): void {
  const fields: [string, string | undefined][] = [
    ["body", env.body],
    ["to", env.to],
  ];
  (env.refs ?? []).forEach((ref, i) => {
    for (const k of ["repo", "path", "lines", "commit"] as const) {
      fields.push([`refs[${i}].${k}`, ref[k]]);
    }
  });
  for (const [field, text] of fields) {
    if (text === undefined) continue;
    const hit = scanText(text);
    if (hit) throw new SecretFoundError(hit.rule, field, hit.explanation);
  }
}
