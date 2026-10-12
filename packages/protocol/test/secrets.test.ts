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
  "room a3f1c2e4b5d6978812345678900abcdef0123456789abcdef0123456789abcd",
  "id 01HZY3K9V7Q2M4N6P8R0S2T4W6",
  "vector AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  "share code ar1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  j("sk", "_test_", "a1B2c3D4e5F6g7H8i9J0k1L2"),
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
});
