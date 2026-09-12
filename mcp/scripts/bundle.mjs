#!/usr/bin/env node
/**
 * Bundle Screen Beaver MCP into a single ESM file with no runtime npm deps.
 * Keeps the published package free of the MCP SDK's large transitive tree
 * (express, cors, cross-spawn, …) that Socket flags as shell/eval/network risk.
 */
import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Node built-ins stay external; everything else is inlined.
  packages: "bundle",
  logLevel: "info",
});

console.log("Bundled mcp → dist/index.js");
