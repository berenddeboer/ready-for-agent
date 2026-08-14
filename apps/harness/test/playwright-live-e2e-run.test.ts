import { resolvePlaywrightLiveE2eRun } from "../e2e/support/playwright-live-e2e-run.ts"
import { describe, expect, test } from "bun:test"

describe("resolvePlaywrightLiveE2eRun (issue #1000)", () => {
  test("live-Forge and the union suite keep one shared webServer worker", () => {
    expect(resolvePlaywrightLiveE2eRun({})).toEqual({
      workers: 1,
      fullyParallel: false,
      isolateHarnessWorkers: false,
      webServerEnabled: true,
    })
    expect(resolvePlaywrightLiveE2eRun({ E2E_HARNESS_WORKERS: "1" })).toEqual({
      workers: 1,
      fullyParallel: false,
      isolateHarnessWorkers: false,
      webServerEnabled: true,
    })
  })

  test("UI-history isolation starts one Harness per Playwright worker", () => {
    expect(resolvePlaywrightLiveE2eRun({ E2E_HARNESS_WORKERS: "2" })).toEqual({
      workers: 2,
      fullyParallel: true,
      isolateHarnessWorkers: true,
      webServerEnabled: false,
    })
  })

  test("rejects a non-positive worker count", () => {
    expect(() =>
      resolvePlaywrightLiveE2eRun({ E2E_HARNESS_WORKERS: "0" }),
    ).toThrow(/E2E_HARNESS_WORKERS/)
  })
})

describe("UI-history Playwright wiring (issue #1000)", () => {
  test("config and worker fixture honor E2E_HARNESS_WORKERS isolation", async () => {
    const { readFile } = await import("node:fs/promises")
    const config = await readFile(
      new URL("../playwright.config.ts", import.meta.url),
      "utf8",
    )
    const fixtures = await readFile(
      new URL("../e2e/steps/fixtures.ts", import.meta.url),
      "utf8",
    )
    const supervisor = await readFile(
      new URL("../e2e/support/start-live-harness.ts", import.meta.url),
      "utf8",
    )

    expect(config).toContain("resolvePlaywrightLiveE2eRun")
    expect(config).toContain("webServerEnabled")
    expect(fixtures).toContain("startWorkerLiveHarness")
    expect(fixtures).toContain("isolateHarnessWorkers")
    expect(supervisor).toContain("liveHarnessSupervisorBindings")
    expect(supervisor).toContain("liveHarnessStateFilePath")
    expect(supervisor).toContain("OPENCODE_DB")
  })
})
