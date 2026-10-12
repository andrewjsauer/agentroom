import { createInterface } from "node:readline";
import {
  agentroomHome,
  oneShot,
  type RoomFile,
  readRoomFile,
  setCurrent,
  writeRoomFile,
} from "@agentroom/mcp";
import {
  deriveRoom,
  openMeta,
  parseShareCode,
  ShareCodeError,
} from "@agentroom/protocol";
import { type CliContext, CliError, parseAgent } from "../context.js";
import { resolveRelay } from "../relay-url.js";
import { afterRoomReady } from "./install.js";
import { defaultMember, hoursUntil } from "./up.js";

function promptForCode(ctx: CliContext): Promise<string> {
  const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
  return new Promise((resolve) => {
    // End of input (Ctrl-D) closes without an answer; resolve empty so parsing reports it.
    rl.once("close", () => resolve(""));
    rl.question("Share code: ", (answer) => {
      resolve(answer.trim());
      rl.close();
    });
  });
}

export async function join(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const agent = parseAgent(values.agent);
  let code = positionals[0];
  if (code === undefined) {
    if (!ctx.isTTY) {
      throw new CliError(
        "pass the share code as an argument or run in a terminal to be prompted",
        2,
      );
    }
    code = await promptForCode(ctx);
  }
  let secret: Uint8Array;
  try {
    secret = parseShareCode(code);
  } catch (err) {
    if (err instanceof ShareCodeError) throw new CliError(err.message, 2);
    throw err;
  }
  const { roomId, key } = deriveRoom(secret);
  const relay = resolveRelay(values.relay, ctx.env);

  const res = await oneShot({
    url: relay,
    hello: { t: "hello", room: roomId, proto: 1 },
  });
  if (res.t === "error") {
    if (res.code === "room_not_found" || res.code === "room_expired") {
      throw new CliError(
        `room not found on ${relay}: it expired, was closed, or the relay restarted. Check --relay if the creator used a different one.`,
      );
    }
    throw new CliError(`relay refused the join: ${res.code} (${res.message})`);
  }
  await openMeta(res.meta, key, roomId);

  const home = agentroomHome(ctx.env);
  const member = values.name || defaultMember();
  let existing: RoomFile | undefined;
  try {
    existing = readRoomFile(home, roomId);
  } catch {
    existing = undefined;
  }
  writeRoomFile(home, {
    v: 1,
    roomId,
    secret: code,
    relay,
    member,
    agent,
    createdByMe: existing?.createdByMe ?? false,
    closeSecretKey: existing?.closeSecretKey,
  });
  setCurrent(home, roomId);

  ctx.stdout.write(
    [
      `Joined room ${roomId} as ${member} (${agent}) via ${relay}.`,
      `Expires after ${hoursUntil(res.expiresAt)} h without activity (${new Date(res.expiresAt).toISOString()}).`,
      "",
    ].join("\n"),
  );
  return afterRoomReady(roomId, agent, ctx);
}
