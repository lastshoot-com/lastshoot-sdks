import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  dts: { entry: "src/server.ts" },
  sourcemap: true,
  clean: true,
  target: "node18",
  platform: "node",
  // Keep the SDKs as real dependencies (not bundled).
  external: ["@lastshoot/sdk", "@modelcontextprotocol/sdk", "zod"],
});
