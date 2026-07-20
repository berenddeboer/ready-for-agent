import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { backendRuntimeRestart } from "./src/server/backend-runtime-restart.js"

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
  plugins: [
    backendRuntimeRestart(workspaceRoot),
    tanstackStart({ spa: { enabled: true } }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    conditions: ["@ready-for-agent/source"],
  },
  ssr: {
    noExternal: [/^@ready-for-agent\//],
    // pkce-challenge (via MCP SDK) only publishes "node" / "browser" export
    // conditions — include "node" so production SSR can resolve it.
    resolve: {
      conditions: ["@ready-for-agent/source", "node", "import"],
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 6056),
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 6056),
    strictPort: true,
  },
})
