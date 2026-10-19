/**
 * After a Tauri SPA build (nitro off), TanStack may emit odd asset URLs like
 * `/./assets/...` and absolute `/favicon.ico`. Rewrite to relative paths so
 * WebView2 resolves them under tauri.localhost.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(root, "dist", "client");
const indexPath = path.join(clientDir, "index.html");

if (!fs.existsSync(indexPath)) {
  console.error(`Missing ${indexPath} — Tauri SPA build did not emit index.html.`);
  process.exit(1);
}

let html = fs.readFileSync(indexPath, "utf8");
const before = html;

html = html
  .replaceAll("/./assets/", "./assets/")
  .replaceAll('href="/assets/', 'href="./assets/')
  .replaceAll('src="/assets/', 'src="./assets/')
  .replaceAll('href="/favicon.ico"', 'href="./favicon.ico"')
  .replaceAll('href="/apple-touch-icon.png"', 'href="./apple-touch-icon.png"')
  .replaceAll('href="/logo.png"', 'href="./logo.png"')
  .replaceAll('"/./assets/', '"./assets/')
  .replaceAll('"/assets/', '"./assets/');

if (html !== before) {
  fs.writeFileSync(indexPath, html, "utf8");
  console.log("Rewrote absolute asset paths in dist/client/index.html for Tauri.");
} else {
  console.log("dist/client/index.html asset paths already relative.");
}

// Ensure theme boot exists (prerender already includes it from RootShell).
if (!html.includes("sw-app-theme")) {
  console.warn("Warning: theme boot script missing from prerendered shell.");
}

// Vite/TanStack SPA emit may omit `public/` copies into dist/client — ship them for Tauri.
const publicDir = path.join(root, "public");
const copyDirs = ["wallpapers", "sounds", "home"];
for (const name of copyDirs) {
  const from = path.join(publicDir, name);
  const to = path.join(clientDir, name);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, to, { recursive: true });
  console.log(`Copied public/${name} → dist/client/${name}`);
}
for (const file of ["favicon.ico", "logo.png", "apple-touch-icon.png", "auth-motion-blur.png"]) {
  const from = path.join(publicDir, file);
  const to = path.join(clientDir, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
}

console.log("Tauri frontend ready:", path.relative(root, indexPath));
