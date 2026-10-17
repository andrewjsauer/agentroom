import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Replace a config file atomically without changing what it is: a symlink is followed and its
 * target rewritten, an existing file keeps its mode, and a new one gets `newMode`. Missing parent
 * directories are created 0700; an existing directory is never chmodded (these files belong to
 * the user's agents, not to agentroom).
 */
export function writeConfigFile(
  file: string,
  text: string,
  newMode?: number,
): void {
  const exists = existsSync(file);
  const target = exists ? realpathSync(file) : file;
  const mode = exists ? statSync(target).mode & 0o777 : newMode;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(6).toString("hex")}.agentroom-tmp`;
  writeFileSync(tmp, text, { mode });
  if (mode !== undefined) chmodSync(tmp, mode); // exact mode, whatever the umask
  renameSync(tmp, target);
}
