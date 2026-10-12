import { userInfo } from "node:os";
import {
  agentroomHome,
  oneShot,
  setCurrent,
  writeRoomFile,
} from "@agentroom/mcp";
import {
  deriveRoom,
  generateCloseKeyPair,
  generateShareCode,
  sealMeta,
} from "@agentroom/protocol";
import { type CliContext, CliError, parseAgent } from "../context.js";
import { DEFAULT_RELAY, resolveRelay } from "../relay-url.js";
import { afterRoomReady } from "./install.js";

export function defaultMember(): string {
  return userInfo().username;
}

export function hoursUntil(ms: number): number {
  return Math.round((ms - Date.now()) / 3_600_000);
}

/** `--ttl <n>h|<n>m` as seconds, n a positive integer (KTD10). */
function parseTtl(flag: string): number {
  const m = /^([1-9]\d*)([hm])$/.exec(flag);
  if (!m) {
    throw new CliError(
      "--ttl must look like 2h or 30m (a positive whole number)",
      2,
    );
  }
  return Number(m[1]) * (m[2] === "h" ? 3600 : 60);
}

/** The expiry line: minutes when under 2 h; "without activity" only when the idle TTL applies. */
function expiryLine(expiresAt: number, maxAge: boolean): string {
  const ms = expiresAt - Date.now();
  const left =
    ms < 2 * 3_600_000
      ? `${Math.max(0, Math.round(ms / 60_000))} min`
      : `${hoursUntil(expiresAt)} h`;
  const iso = new Date(expiresAt).toISOString();
  return maxAge
    ? `Expires in ${left} (${iso}).`
    : `Expires after ${left} without activity (${iso}).`;
}

export async function up(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const agent = parseAgent(values.agent);
  const member = values.name || defaultMember();
  const relay = resolveRelay(values.relay, ctx.env);
  let maxAgentChain = 3;
  if (values["max-chain"] !== undefined) {
    maxAgentChain = Number(values["max-chain"]);
    if (!Number.isInteger(maxAgentChain) || maxAgentChain < 1) {
      throw new CliError("--max-chain must be a positive integer", 2);
    }
  }

  const maxAgeSec = values.ttl === undefined ? undefined : parseTtl(values.ttl);

  const { code, secret } = generateShareCode();
  const { roomId, key } = deriveRoom(secret);
  const closeKeys = await generateCloseKeyPair();
  const meta = await sealMeta({ maxAgentChain }, key, roomId);
  const res = await oneShot({
    url: relay,
    hello: {
      t: "hello",
      room: roomId,
      proto: 1,
      create: { closeKey: closeKeys.publicKey, maxAgeSec, meta },
    },
  });
  if (res.t === "error") {
    throw new CliError(
      `relay refused to create the room: ${res.code} (${res.message})`,
    );
  }

  const home = agentroomHome(ctx.env);
  writeRoomFile(home, {
    v: 1,
    roomId,
    secret: code,
    relay,
    member,
    agent,
    createdByMe: true,
    closeSecretKey: closeKeys.secretKey,
  });
  setCurrent(home, roomId);

  const relayFlag = relay === DEFAULT_RELAY ? "" : ` --relay ${relay}`;
  ctx.stdout.write(
    [
      "Room ready. Share this code with your coworker (it is the room secret):",
      code,
      "They run:",
      `  agentroom join ${code}${relayFlag}`,
      `Room id: ${roomId}`,
      expiryLine(res.expiresAt, maxAgeSec !== undefined),
      "",
    ].join("\n"),
  );
  return afterRoomReady(roomId, agent, ctx);
}
