import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";
import { createRoomSession } from "./session.js";

/**
 * Serve the room over stdio. Throws before touching stdout when room.json is missing or invalid.
 * Resolves once stdin ends, after the relay connection and timers are released, so the caller can exit.
 */
export function runStdio(opts: {
  roomId: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const session = createRoomSession(opts);
  const handle = serveStdio(() => createMcpServer(session), {
    onerror: (err) => process.stderr.write(`agentroom: ${err.message}\n`),
  });
  return new Promise((resolve) => {
    let done = false;
    const shutdown = () => {
      if (done) return;
      done = true;
      session.close();
      handle.close().then(resolve, resolve);
    };
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  });
}
