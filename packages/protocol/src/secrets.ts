import type { EnvelopeInput } from "./envelope.js";

interface Rule {
  name: string;
  test: (text: string) => boolean;
  explanation: string;
}

const re = (r: RegExp) => (text: string) => r.test(text);

/** Common stand-ins that are not real passwords. */
const PLACEHOLDER =
  /^(?:\*+|x+|\.{3,}|<[^>]*>|\$\{?\w+\}?|%\w+%|\{\{.*\}\}|(?:your|my|the)[-_]?pass\w*|pass(?:word|wd)?\d*|changeme|placeholder|redacted|example\w*)$/i;

/** `scheme://user:password@host` for database, queue and web schemes; password in group 2. */
const URL_CREDENTIALS =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|https?):\/\/([^\s:@/]+):([^\s:@/]+)@[^\s/@]+/gi;

function urlCredentials(text: string): boolean {
  for (const m of text.matchAll(URL_CREDENTIALS)) {
    if (!PLACEHOLDER.test(m[2] as string)) return true;
  }
  return false;
}

/**
 * `password=`/`passwd=`/`pwd=` with a value of 8+ characters, quoted or not, at any entropy.
 * To keep code like `password: EditText` or `password = config.password` quiet, the value must
 * hold a digit or symbol, and an unquoted value must not run into `(`, `[` or `<`.
 */
const PASSWORD =
  /(?:password|passwd|pwd)["']?\s*(?::=|=>|=|:)\s*(?:(["'`])([^"'`\s]{8,200})\1|([^\s"'`,;&()[\]{}<>]{8,200})(?=$|[\s,;&]))/gi;

function passwordAssignment(text: string): boolean {
  for (const m of text.matchAll(PASSWORD)) {
    const value = (m[2] ?? m[3]) as string;
    if (/^[A-Za-z_.$]+[?!]?$/.test(value)) continue;
    if (/^[~.]?\//.test(value)) continue;
    if (PLACEHOLDER.test(value)) continue;
    return true;
  }
  return false;
}

const AWS_KEY_ID = /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/;
const BARE_40 = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

/** A bare 40-character AWS-secret-shaped value, only when an AWS key id is in the same text. */
function awsSecretNearKeyId(text: string): boolean {
  if (!AWS_KEY_ID.test(text)) return false;
  for (const m of text.matchAll(BARE_40)) {
    const v = m[0];
    if (/[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9+/]/.test(v)) return true;
  }
  return false;
}

/**
 * Credential rules ported from gitleaks config/gitleaks.toml (inline `(?i)` rewritten as
 * whole-regex flags, which Node 20 requires) plus the git-secrets AWS secret pattern.
 * Sources and porting notes: docs/OPEN_QUESTIONS.md.
 */
const RULES: Rule[] = [
  {
    name: "aws-secret-near-key-id",
    test: awsSecretNearKeyId,
    explanation:
      "It contains an AWS access key id next to a 40-character value shaped like its secret.",
  },
  {
    name: "aws-access-key-id",
    test: re(AWS_KEY_ID),
    explanation: "It matches the shape of an AWS access key id.",
  },
  {
    name: "aws-secret-access-key",
    test: re(
      /(?:aws[_-]?(?:secret[_-]?)?(?:access[_-]?)?key|secret[_-]?(?:access[_-]?)?key)["']?\s*(?::|=>|=)\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
    ),
    explanation: "It looks like an AWS secret access key assignment.",
  },
  {
    name: "github-pat",
    test: re(/\bghp_[0-9a-zA-Z]{36}\b/),
    explanation: "It matches a GitHub personal access token.",
  },
  {
    name: "github-oauth",
    test: re(/\bgho_[0-9a-zA-Z]{36}\b/),
    explanation: "It matches a GitHub OAuth token.",
  },
  {
    name: "github-app-token",
    test: re(/\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\b/),
    explanation: "It matches a GitHub app token.",
  },
  {
    name: "github-refresh-token",
    test: re(/\bghr_[0-9a-zA-Z]{36}\b/),
    explanation: "It matches a GitHub refresh token.",
  },
  {
    name: "github-fine-grained-pat",
    test: re(/\bgithub_pat_\w{82}\b/),
    explanation: "It matches a GitHub fine-grained personal access token.",
  },
  {
    name: "gitlab-pat",
    test: re(/\bglpat-[\w-]{20,}/),
    explanation: "It matches a GitLab personal access token.",
  },
  {
    name: "slack-token",
    test: re(/\bxox[baprseo]-[0-9A-Za-z-]{10,}/),
    explanation: "It matches a Slack token.",
  },
  {
    name: "slack-app-token",
    test: re(/\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/i),
    explanation: "It matches a Slack app-level token.",
  },
  {
    name: "slack-webhook-url",
    test: re(
      /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/i,
    ),
    explanation: "It contains a Slack incoming webhook URL.",
  },
  {
    name: "anthropic-api-key",
    test: re(/\bsk-ant-[A-Za-z0-9_-]{20,}/),
    explanation: "It matches an Anthropic API key.",
  },
  {
    name: "openai-api-key",
    test: re(
      /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/,
    ),
    explanation: "It matches an OpenAI API key.",
  },
  {
    name: "npm-access-token",
    test: re(/\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/),
    explanation: "It matches an npm access token.",
  },
  {
    name: "huggingface-access-token",
    test: re(/\bhf_[A-Za-z]{34}(?![A-Za-z0-9])/),
    explanation: "It matches a Hugging Face access token.",
  },
  {
    name: "sendgrid-api-key",
    test: re(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/),
    explanation: "It matches a SendGrid API key.",
  },
  {
    name: "private-key",
    test: re(/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/),
    explanation: "It contains a private key header.",
  },
  {
    name: "jwt",
    test: re(
      /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?/,
    ),
    explanation: "It matches a JSON Web Token.",
  },
  {
    name: "gcp-api-key",
    test: re(/\bAIza[\w-]{35}(?![\w-])/),
    explanation: "It matches a Google Cloud API key.",
  },
  {
    name: "stripe-live-key",
    test: re(/\b[sr]k_(?:live|prod)_[A-Za-z0-9]{10,}/),
    explanation: "It matches a live Stripe key.",
  },
  {
    name: "stripe-test-key",
    test: re(/\b[sr]k_test_[A-Za-z0-9]{10,}/),
    explanation: "It matches a Stripe test key.",
  },
  {
    name: "agentroom-share-code",
    test: re(/\bar1_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/),
    explanation:
      "It matches an agentroom share code, which lets anyone holding it join the room.",
  },
  {
    name: "url-credentials",
    test: urlCredentials,
    explanation:
      "It contains a URL with a password in it (user:password@host).",
  },
  {
    name: "password-assignment",
    test: passwordAssignment,
    explanation: "It looks like a password assigned a literal value.",
  },
];

/** Keyword assignment with a high-entropy value (KTD24). Name in group 1, value in group 2. */
const GENERIC =
  /([A-Za-z0-9_]{0,30}(?:key|token|secret|passwd|password)[A-Za-z0-9_]{0,20})["']?\s*(?::\s*[A-Za-z_][\w.<>?]*\s*)?(?:=>|:=|=|:)\s*["']?([A-Za-z0-9_\-+/=.~]{20,150})(?![A-Za-z0-9_\-+/=.~])/gi;
const GENERIC_NAME_ALLOW =
  /(?:alias|url|uri|length|len|size|name|id|header|field|type|provider|path|file)$|^csrf/i;
const GENERIC_EXPLANATION =
  "It looks like a key, token, secret or password assigned a random-looking value.";

function shannonEntropy(s: string): number {
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
    // A git object id (40 or 64 hex) is not a credential; refs carry them and bodies cite them.
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) continue;
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

interface Hit {
  rule: string;
  explanation: string;
}

function scanOnce(text: string): Hit | undefined {
  for (const r of RULES) {
    if (r.test(text)) return { rule: r.name, explanation: r.explanation };
  }
  if (genericMatch(text)) {
    return { rule: "generic-assignment", explanation: GENERIC_EXPLANATION };
  }
  return undefined;
}

/**
 * Every format character (\p{Cf}: zero-width characters, bidi marks and controls, soft hyphen,
 * BOM) and the whole Unicode Tag block: the same set `stripControl` removes before display, so a
 * token split by any of them reaches the recipient whole.
 */
const INVISIBLE = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;

/** The scan copy: invisible characters removed, then NFKC (full-width and styled letters folded). */
function normalizeForScan(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFKC");
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Each base64 or base64url run of 40+ characters that decodes to valid UTF-8 text. */
function decodedBase64Runs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BASE64_RUN)) {
    try {
      out.push(UTF8.decode(Buffer.from(m[0], "base64")));
    } catch {
      // Binary payloads (images, hashes) are not text; nothing to scan.
    }
  }
  return out;
}

function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  }
}

/**
 * Scan the text as sent, then its normalized copy, then each base64 run decoded once (no
 * recursion), then the URL-decoded copy for credentials in URLs.
 */
function scanText(text: string): Hit | undefined {
  const hit = scanOnce(text);
  if (hit) return hit;
  const norm = normalizeForScan(text);
  if (norm !== text) {
    const h = scanOnce(norm);
    if (h) return h;
  }
  for (const decoded of decodedBase64Runs(norm)) {
    const h = scanOnce(decoded);
    if (h) {
      return {
        rule: h.rule,
        explanation: `${h.explanation} It was found inside base64-encoded text.`,
      };
    }
  }
  const unescaped = urlDecode(norm);
  if (unescaped !== norm && urlCredentials(unescaped)) {
    return {
      rule: "url-credentials",
      explanation:
        "It contains a URL with a password in it (user:password@host), found after URL-decoding.",
    };
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
