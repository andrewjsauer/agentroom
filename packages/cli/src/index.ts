import { parseCli, USAGE } from "./args.js";
import { approve } from "./commands/approve.js";
import { down } from "./commands/down.js";
import { install } from "./commands/install.js";
import { join } from "./commands/join.js";
import { mcp } from "./commands/mcp.js";
import { say } from "./commands/say.js";
import { status } from "./commands/status.js";
import { up } from "./commands/up.js";
import { type CliContext, CliError } from "./context.js";

export { type CliContext, CliError } from "./context.js";
export { DEFAULT_RELAY, resolveRelay } from "./relay-url.js";

/** Package version; the test keeps it equal to package.json. */
export const VERSION = "0.0.0";

/** Run one CLI invocation and return the exit code. Never calls process.exit. */
export async function main(argv: string[], ctx: CliContext): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseCli>;
    try {
      parsed = parseCli(argv);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), 2);
    }
    switch (parsed.command) {
      case "help":
        ctx.stdout.write(USAGE);
        return 0;
      case "version":
        ctx.stdout.write(`${VERSION}\n`);
        return 0;
      case "up":
        return await up(parsed.values, ctx);
      case "join":
        return await join(parsed.positionals, parsed.values, ctx);
      case "status":
        return await status(parsed.values, ctx);
      case "say":
        return await say(parsed.positionals, parsed.values, ctx);
      case "approve":
        return await approve(parsed.positionals, parsed.values, ctx);
      case "down":
        return await down(parsed.values, ctx);
      case "install":
        return install(parsed.positionals, parsed.values, ctx);
      case "mcp":
        return await mcp(parsed.values, ctx);
    }
  } catch (err) {
    if (err instanceof CliError) {
      ctx.stderr.write(`agentroom: ${err.message}\n`);
      if (err.code === 2) ctx.stderr.write(USAGE);
      return err.code;
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`agentroom: ${message}\n`);
    return 1;
  }
}
