import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all local state. Every path goes through here so tests can set AGENTROOM_HOME. */
export function agentroomHome(env: NodeJS.ProcessEnv): string {
  return env.AGENTROOM_HOME || join(homedir(), ".agentroom");
}

export function roomDir(home: string, roomId: string): string {
  return join(home, "rooms", roomId);
}

export function currentPath(home: string): string {
  return join(home, "current");
}
