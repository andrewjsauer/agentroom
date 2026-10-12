import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { agentroomHome } from "./paths.js";
import { createMcpServer, createNoRoomServer } from "./server.js";
import { createRoomSession, type RoomSession } from "./session.js";
import { roomExists } from "./state.js";

/** The room to serve: the requested one when its room.json exists, else none (KTD4). */
export function roomToServe(
  roomId: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return roomId !== undefined && roomExists(agentroomHome(env), roomId)
    ? roomId
    : undefined;
}

/**
 * Serve the room over stdio, or the no-room stub when there is no room to serve. Throws before
 * touching stdout when room.json is invalid. Resolves once stdin ends, after the relay
 * connection and timers are released, so the caller can exit.
 */
export function runStdio(opts: {
  roomId: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const roomId = roomToServe(opts.roomId, opts.env);
  let session: RoomSession | undefined;
  if (roomId !== undefined)
    session = createRoomSession({ roomId, env: opts.env });
  const handle = serveStdio(
    () => (session ? createMcpServer(session) : createNoRoomServer()),
    { onerror: (err) => process.stderr.write(`agentroom: ${err.message}\n`) },
  );
  return new Promise((resolve) => {
    let done = false;
    const shutdown = () => {
      if (done) return;
      done = true;
      session?.close();
      handle.close().then(resolve, resolve);
    };
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  });
}
