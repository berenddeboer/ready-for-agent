import { defineConfig } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"
import {
  HARNESS_START_TIMEOUT_MS,
  SCENARIO_TIMEOUT_MS,
  SENTINEL_EXPECT_TIMEOUT_MS,
} from "./e2e/support/constants.ts"
import { liveHarnessWorkerIdentityForSlot } from "./e2e/support/live-harness-worker.ts"
import { resolvePlaywrightLiveE2eRun } from "./e2e/support/playwright-live-e2e-run.ts"

const testDir = defineBddConfig({
  features: "e2e/features/**/*.feature",
  steps: "e2e/steps/**/*.ts",
})

const liveE2eRun = resolvePlaywrightLiveE2eRun(process.env)
const worker0 = liveHarnessWorkerIdentityForSlot({ workerIndex: 0 })

export default defineConfig({
  testDir,
  fullyParallel: liveE2eRun.fullyParallel,
  workers: liveE2eRun.workers,
  retries: 0,
  timeout: SCENARIO_TIMEOUT_MS,
  expect: {
    timeout: SENTINEL_EXPECT_TIMEOUT_MS,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: worker0.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: liveE2eRun.webServerEnabled
    ? {
        command:
          "bun --conditions @ready-for-agent/source e2e/support/start-live-harness.ts",
        url: worker0.baseUrl,
        reuseExistingServer: false,
        timeout: HARNESS_START_TIMEOUT_MS,
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,
})
