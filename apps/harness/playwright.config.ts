import { defineConfig } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"
import {
  E2E_BASE_URL,
  HARNESS_START_TIMEOUT_MS,
  SCENARIO_TIMEOUT_MS,
  SENTINEL_EXPECT_TIMEOUT_MS,
} from "./e2e/support/constants.ts"

const testDir = defineBddConfig({
  features: "e2e/features/**/*.feature",
  steps: "e2e/steps/**/*.ts",
})

export default defineConfig({
  testDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: SCENARIO_TIMEOUT_MS,
  expect: {
    timeout: SENTINEL_EXPECT_TIMEOUT_MS,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "bun --conditions @ready-for-agent/source e2e/support/start-live-harness.ts",
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: HARNESS_START_TIMEOUT_MS,
    stdout: "pipe",
    stderr: "pipe",
  },
})
