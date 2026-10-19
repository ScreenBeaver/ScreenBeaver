import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Tauri sets these during `tauri build` / `tauri dev`.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  ...(isTauri ? { base: "./" } : {}),
  resolve: {
    alias: {
      "@": path.join(rootDir, "src"),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
  },
  // Never watch Rust build artifacts — locked DLLs throw EBUSY and kill `tauri dev`.
  server: {
    watch: {
      ignored: [
        "**/src-tauri/target/**",
        "**/src-tauri/gen/**",
        "**/src-tauri/resources/mcp/**",
        "**/node_modules/**",
      ],
    },
  },
  optimizeDeps: {
    exclude: ["@xenova/transformers"],
  },
  plugins: [
    viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
      server: { entry: "server" },
      ...(isTauri
        ? {
            spa: {
              enabled: true,
              prerender: {
                outputPath: "/index.html",
                crawlLinks: false,
                retryCount: 0,
              },
            },
          }
        : {}),
    }),
    viteReact(),
    ...(isTauri ? [] : [nitro()]),
  ],
});
