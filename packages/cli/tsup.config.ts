import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: { resolve: [/^@agentroom\//] },
  target: "node20",
  clean: true,
  sourcemap: true,
  // The workspace packages are not published; bundle them so `agentroom` installs on its own.
  noExternal: [/^@agentroom\//],
});
