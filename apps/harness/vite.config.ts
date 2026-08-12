import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { backendRuntimeRestart } from "./src/server/backend-runtime-restart.js"
import {
  parseHostFlagFromArgv,
  resolveListenHost,
} from "./src/server/listen-host.js"

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

/** Same `--host` / HOST / default semantics as production lifecycle (Vite-style). */
const listenHost = resolveListenHost({
  flag: parseHostFlagFromArgv(process.argv),
  env: process.env.HOST,
})
const listenPort = Number(process.env.PORT ?? 6056)

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
    host: listenHost,
    port: listenPort,
    strictPort: true,
  },
  preview: {
    host: listenHost,
    port: listenPort,
    strictPort: true,
  },
})
