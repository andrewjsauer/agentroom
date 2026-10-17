import { describe, expect, test } from "vitest";
import {
  assertNoSecrets,
  deriveRoom,
  type EnvelopeInput,
  type Ref,
  SecretFoundError,
  seal,
} from "../src/index.js";

// KTD5: positives are assembled at runtime so no contiguous secret-shaped string is committed.
const j = (...parts: string[]) => parts.join("");
const alnum36 = j("a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8");
const fakeAwsId = j("AKIA", "Z7Q2K4M6N3P5R2T4");

function envOf(body: string, refs: Ref[] = []): EnvelopeInput {
  return {
    v: 1,
    id: "01J00000000000000000000000",
    ts: 1,
    from: { member: "alice", agent: "claude-code", via: "mcp" },
    kind: "fyi",
    thread: "01J00000000000000000000000",
    body,
    refs,
  };
}

function ruleFor(body: string, refs: Ref[] = []): string | undefined {
  try {
    assertNoSecrets(envOf(body, refs));
    return undefined;
  } catch (e) {
    if (e instanceof SecretFoundError) return e.rule;
    throw e;
  }
}

const positives: [string, string][] = [
  ["aws-access-key-id", `key id ${fakeAwsId} here`],
  ["aws-access-key-id", j("ASIA", "ABCDEFGHIJKLMNOP")],
  [
    "aws-secret-access-key",
    `aws_secret_access_key = ${j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYzz9a8b7c6d")}`,
  ],
  ["github-pat", j("gh", "p_", alnum36)],
  ["github-oauth", j("gh", "o_", alnum36)],
  ["github-app-token", j("gh", "s_", alnum36)],
  ["github-refresh-token", j("gh", "r_", alnum36)],
  [
    "github-fine-grained-pat",
    j("github", "_pat_", "A".repeat(22), "_", "b1".repeat(29), "c"),
  ],
  [
    "slack-token",
    j("xo", "xb-", "1234567890-1234567890-", "abcdefABCDEF123456"),
  ],
  [
    "slack-app-token",
    j("xa", "pp-1-", "A0123BCDE-1234567890-", "abcdef0123456789"),
  ],
  ["private-key", j("-----BEGIN RSA ", "PRIVATE KEY-----")],
  [
    "jwt",
    j(
      "eyJhbGciOiJIUzI1NiJ9",
      ".",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      ".",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
  ],
  ["gcp-api-key", j("AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")],
  ["stripe-live-key", j("sk", "_live_", "a1B2c3D4e5F6g7H8i9J0k1L2")],
  ["stripe-test-key", j("sk", "_test_", "a1B2c3D4e5F6g7H8i9J0k1L2")],
  ["stripe-test-key", j("rk", "_test_", "a1B2c3D4e5F6g7H8i9J0k1L2")],
  [
    "anthropic-api-key",
    j("sk-ant-", "api03-", "aB3dE5fG7hJ9kL1mN3pQ5r".repeat(4), "x9AA"),
  ],
  ["anthropic-api-key", j("sk-ant-", "admin01-", "Q7w8E9r0T1y2U3i4O5p6A7s8")],
  [
    "openai-api-key",
    j("sk-", "proj-", "Ab3De5Fg7Hj9".repeat(6), "T3Blbk", "FJ"),
  ],
  [
    "openai-api-key",
    j("sk-", "a1B2c3D4e5F6g7H8i9J0", "T3Blbk", "FJ", "k1L2m3N4o5P6q7R8s9T0"),
  ],
  ["gitlab-pat", j("gl", "pat-", "xY9zA8bC7dE6fG5hI4jK")],
  ["npm-access-token", j("np", "m_", alnum36)],
  [
    "huggingface-access-token",
    `HF=${j("h", "f_", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh")}`,
  ],
  [
    "sendgrid-api-key",
    j(
      "SG",
      ".",
      "aB3dE5fG7hJ9kL1mN3pQ5r",
      ".",
      "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz9Xc8Vb7Nm6Q",
    ),
  ],
  [
    "slack-webhook-url",
    j(
      "https://hooks.",
      "slack.com/services/",
      "T0123ABCD/B0456EFGH/",
      "aB3dE5fG7hJ9kL1mN3pQ5rS7",
    ),
  ],
  [
    "agentroom-share-code",
    j("join with ar", "1_", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"),
  ],
  [
    "url-credentials",
    j("DATABASE_URL=postgres://app:", "Tr0ub4dor3@db.internal:5432/app"),
  ],
  [
    "url-credentials",
    j("mongodb+srv://admin:", "s3cr3tPass@cluster0.example.net/db"),
  ],
  ["url-credentials", j("redis://default:", "hunter22@cache:6379")],
  ["url-credentials", j("amqp://guest:", "rabbit99@mq/vhost")],
  ["url-credentials", j("mysql://root:", "toor1234@127.0.0.1/db")],
  [
    "url-credentials",
    j("clone https://bob:", "tokenvalue1@code.example.com/r"),
  ],
  ["password-assignment", j("DB_PASSWORD=", "hunter22")],
  ["password-assignment", j('"password": "', 'Summer2024!"')],
  ["password-assignment", j("--passwd=", "abc12345")],
  ["password-assignment", j("pwd: ", "letmein99")],
  ["password-assignment", j("login?user=bob&password=", "s3cret12&next=/")],
  ["generic-assignment", j('apiKey = "', "a8F3kQ9zL2mN7pR4tV6wX1yB", '"')],
  [
    "generic-assignment",
    j('let apiKey: String = "', "9f8e7d6c5b4a39281706f5e4d3c2b1a0", '"'),
  ],
  ["generic-assignment", j("API_TOKEN=", "Zx9Qw8Er7Ty6Ui5Op4As3Df2")],
];

const negatives = [
  "val tokenProvider: TokenProvider = DefaultTokenProvider()",
  "private val passwordField: EditText",
  'const val KEY_ALIAS = "com.example.sdk.keystore"',
  'let secretKeyAlias = "com.example.sdk.keychain.alias"',
  "var apiKeyHeaderName: String",
  "func refreshToken(completion: @escaping (Result<Token, Error>) -> Void)",
  "val token: AuthenticationTokenRepository",
  "password = PasswordEncoderFactoryImpl()",
  "monkey=BananaRepublicExtraordinaire",
  'val keyAlias = "release_signing_key_2024_v1"',
  'val cacheKey = "user_profile_cache_v2_12345"',
  "key = R.string.preference_notification_key_v2",
  "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
  "room a3f1c2e4b5d6978812345678900abcdef0123456789abcdef0123456789abcde",
  "id 01HZY3K9V7Q2M4N6P8R0S2T4W6",
  "vector AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  "the password must be at least 8 characters long",
  "password: String",
  "val password: EditText?",
  "password = config.password",
  "password=PasswordEncoderFactoryImpl()",
  'password = os.environ["DB_PASSWORD"]',
  "PGPASSWORD=$PGPASS",
  "password=********",
  'password: "<your-password>"',
  "PWD=/Users/andrew/src/app",
  "DATABASE_URL=postgres://user:password@localhost:5432/app",
  j("postgres://app:$", "{DB_PASS}@db/app"),
  "https://example.com:443/path@v2",
  "ssh://git@github.com/org/repo.git",
  "see https://github.com/org/repo/blob/9fceb02d0ae598e95dc970b74767f19372d61af8/a.ts",
  "packages/protocol/src/secrets.ts and packages/protocol/test/secrets.test.ts",
  "path: /Users/andrew/Documents/projects/agentroom/packages/protocol/src/frame.ts",
  "shas 9fceb02d0ae598e95dc970b74767f19372d61af8 9fceb02d0ae598e95dc970b74767f19372d61af8",
  "use the sk-ant- prefix to recognise Anthropic keys",
  "the hf_hub_download helper",
  "task-ant-colony-simulation-version-two-final",
  "SG.prototype and a short ar1_abc code",
  "a glpat-shortvalue and npm_install_helper",
  j("sk-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X"),
  "sk_test_abc and rk_test_",
  "hooks.slack.com/services/short",
  "join with ar1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh",
  j(
    "![img](data:image/png;base64,",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ")",
  ),
  // Base64 of ordinary prose decodes and scans clean.
  Buffer.from(
    "This paragraph is ordinary prose about the release plan.",
  ).toString("base64"),
  "caf\u00e9, na\u00efve, \u65e5\u672c\u8a9e, and emoji \u{1f469}\u200d\u{1f4bb} in prose",
];

describe("secret scanner", () => {
  test.each(positives)("%s blocks its positive fixture", (rule, body) => {
    expect(ruleFor(body)).toBe(rule);
  });

  test.each(negatives)("passes ordinary text: %s", (body) => {
    expect(ruleFor(body)).toBeUndefined();
  });

  test("a git SHA in refs[0].commit passes", () => {
    expect(
      ruleFor("see ref", [
        {
          repo: "app",
          path: "a.kt",
          commit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
        },
      ]),
    ).toBeUndefined();
  });

  test("a separated base64url-style token still blocks the generic rule", () => {
    expect(ruleFor(j("secret_token: ", "Xk9fQ2_mZ7pL4w-Rt8Yb3NcV"))).toBe(
      "generic-assignment",
    );
  });

  test("a key in the to field is blocked", () => {
    try {
      assertNoSecrets({ ...envOf("hi"), to: fakeAwsId });
      expect.unreachable();
    } catch (e) {
      expect((e as SecretFoundError).field).toBe("to");
    }
  });

  test("a key in refs[1].path is reported with that field", () => {
    try {
      assertNoSecrets(
        envOf("hi", [
          { repo: "r", path: "p" },
          { repo: "r", path: fakeAwsId },
        ]),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as SecretFoundError).field).toBe("refs[1].path");
    }
  });

  test("the error never contains the matched text", () => {
    try {
      assertNoSecrets(envOf(`k ${fakeAwsId}`));
      expect.unreachable();
    } catch (e) {
      const err = e as SecretFoundError;
      const all = JSON.stringify({ ...err, message: err.message });
      expect(all).not.toContain(fakeAwsId);
      expect(all).not.toContain("Z7Q2K4M6");
      expect(err.message).toContain("rule aws-access-key-id, in body");
    }
  });

  test("the AWS documentation example id blocks (EXAMPLE allowlist not ported)", () => {
    expect(ruleFor(j("AKIA", "IOSFODNN7", "EXAMPLE"))).toBe(
      "aws-access-key-id",
    );
  });

  test("seal throws SecretFoundError and returns no blob", async () => {
    const { key, roomId } = deriveRoom(new Uint8Array(32));
    await expect(seal(envOf(fakeAwsId), key, roomId)).rejects.toBeInstanceOf(
      SecretFoundError,
    );
  });

  test("8000 characters of mixed code scan quickly", () => {
    const chunk = 'val tokenKey = "abc_def"; let x = 1; key: value; ';
    const body = chunk.repeat(Math.floor(8000 / chunk.length));
    const start = performance.now();
    expect(ruleFor(body)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(50);
  });

  test("8000 characters of base64 and zero-width text scan quickly", () => {
    const b64 = Buffer.from("plain words ".repeat(400)).toString("base64");
    const body = `${b64.slice(0, 6000)} ${"a\u200bb ".repeat(400)}`;
    const start = performance.now();
    expect(ruleFor(body)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(100);
  });

  test.each([
    ["zero-width space", "\u200b"],
    ["zero-width joiner", "\u200d"],
    ["word joiner", "\u2060"],
    ["byte order mark", "\ufeff"],
    ["soft hyphen", "\u00ad"],
    ["Arabic letter mark", "\u061c"],
    ["Unicode tag", "\u{e0041}"],
  ])("a token split by a %s still blocks", (_name, ch) => {
    const split = [...j("gh", "p_", alnum36)].join(ch);
    expect(ruleFor(`token ${split}`)).toBe("github-pat");
  });

  test("full-width characters are folded with NFKC before matching", () => {
    const fw = [...j("gh", "p_", alnum36)]
      .map((c) => String.fromCodePoint((c.codePointAt(0) as number) + 0xfee0))
      .join("");
    expect(ruleFor(fw)).toBe("github-pat");
  });

  test("a base64-encoded secret is decoded and blocked, naming the inner rule", () => {
    const inner = Buffer.from(`export GH_TOKEN=${j("gh", "p_", alnum36)}`);
    for (const enc of ["base64", "base64url"] as const) {
      try {
        assertNoSecrets(envOf(`config: ${inner.toString(enc)}`));
        expect.unreachable();
      } catch (e) {
        const err = e as SecretFoundError;
        expect(err.rule).toBe("github-pat");
        expect(err.message).toContain("base64");
      }
    }
  });

  test("base64 is decoded once, not recursively", () => {
    const inner = Buffer.from(j("gh", "p_", alnum36)).toString("base64");
    expect(ruleFor(inner)).toBe("github-pat");
    expect(ruleFor(Buffer.from(inner).toString("base64"))).toBeUndefined();
  });

  test("a URL-encoded credentials URL is blocked after decoding", () => {
    const enc = encodeURIComponent(j("postgres://app:", "Tr0ub4dor3@db/app"));
    expect(enc).not.toContain("://");
    expect(ruleFor(`dsn ${enc}`)).toBe("url-credentials");
  });

  test("a bare AWS secret blocks only next to an AWS key id", () => {
    const secret = j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYzz9a8b7c6d");
    expect(ruleFor(`id ${fakeAwsId}\nsecret ${secret}`)).toBe(
      "aws-secret-near-key-id",
    );
    expect(ruleFor(`value ${secret}`)).toBeUndefined();
    expect(
      ruleFor(`${fakeAwsId} at 9fceb02d0ae598e95dc970b74767f19372d61af8`),
    ).toBe("aws-access-key-id");
  });

  test("a token split with spaces is a documented gap and passes", () => {
    const token = j("gh", "p_", alnum36);
    expect(ruleFor(`${token.slice(0, 20)} ${token.slice(20)}`)).toBeUndefined();
  });
});
