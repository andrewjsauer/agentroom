import type { z } from "zod";
import type { CliContext } from "../context.js";

/** Read a stream to its end as UTF-8, failing past `maxBytes` or after `timeoutMs`. */
export function readAll(
  stream: NodeJS.ReadableStream,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > opts.maxBytes) {
        finish(new Error(`stdin is larger than ${opts.maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish();
    const onError = (err: Error) => finish(err);
    const timer = setTimeout(
      () => finish(new Error(`stdin did not end within ${opts.timeoutMs} ms`)),
      opts.timeoutMs,
    );
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/** Read the hook's JSON input from stdin (1 MiB, 5 s) and validate it (KTD5). */
export async function readHookInput<T extends z.ZodType>(
  ctx: CliContext,
  schema: T,
  opts = { maxBytes: 1024 * 1024, timeoutMs: 5_000 },
): Promise<z.output<T>> {
  const text = await readAll(ctx.stdin, opts);
  if (text.trim() === "") throw new Error("hook input on stdin is empty");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("hook input on stdin is not valid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `hook input is not the expected shape: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}
