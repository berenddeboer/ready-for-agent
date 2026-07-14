import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL: "http://127.0.0.1:4174",
  },
  webServer: [
    {
      command: "bun e2e/keymaxxer-stub.ts",
      url: "http://127.0.0.1:59999/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "SQLITE_DATABASE_PATH=/tmp/ready-for-agent-harness-e2e.db bun --conditions @ready-for-agent/source ../../packages/db/src/bin/migrate.ts && SQLITE_DATABASE_PATH=/tmp/ready-for-agent-harness-e2e.db KEYMAXXER_SIDECAR_URL=http://127.0.0.1:59999 bun run dev --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
    },
  ],
})
