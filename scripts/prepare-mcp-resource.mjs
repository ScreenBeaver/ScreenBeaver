/**
 * Always rebuild screen-beaver-mcp, then copy it into Tauri resources.
 * NSIS/MSIX installs spawn this file for Remote MCP — a stale copy is how
 * "works in desktop:dev, breaks after desktop:build:installer" happens.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = path.join(root, "mcp");
const src = path.join(mcpDir, "dist", "index.js");
const destDir = path.join(root, "src-tauri", "resources", "mcp");
const dest = path.join(destDir, "index.js");

console.log("Building mcp (always, so installer never ships a stale bundle)…");
const r = spawnSync("npm", ["run", "build"], {
  cwd: mcpDir,
  stdio: "inherit",
  shell: true,
});
if (r.status !== 0) {
  console.error("Failed to build mcp package");
  process.exit(1);
}

if (!fs.existsSync(src)) {
  console.error("mcp/dist/index.js missing after build");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
const st = fs.statSync(dest);
console.log(
  `Copied MCP bundle → ${path.relative(root, dest)} (${st.size} bytes, ${st.mtime.toISOString()})`,
);
