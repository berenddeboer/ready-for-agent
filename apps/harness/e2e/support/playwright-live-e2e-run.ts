/**
 * Playwright worker / webServer layout for live e2e (issue #1000).
 *
 * `E2E_HARNESS_WORKERS` greater than 1 is the UI-history isolation switch:
 * each Playwright worker starts its own Harness, so a shared `webServer` would
 * race on one database. Live-Forge and the union suite leave the env unset
 * and keep one worker plus Playwright's `webServer`.
 */

export type PlaywrightLiveE2eRun = {
  readonly workers: number
  readonly fullyParallel: boolean
  readonly isolateHarnessWorkers: boolean
  readonly webServerEnabled: boolean
}

const singleWorkerRun: PlaywrightLiveE2eRun = {
  workers: 1,
  fullyParallel: false,
  isolateHarnessWorkers: false,
  webServerEnabled: true,
}

export const resolvePlaywrightLiveE2eRun = (
  env: Record<string, string | undefined>,
): PlaywrightLiveE2eRun => {
  const raw = env.E2E_HARNESS_WORKERS
  if (raw === undefined || raw.trim() === "") {
    return singleWorkerRun
  }
  const workers = Number(raw)
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(
      `E2E_HARNESS_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`,
    )
  }
  if (workers === 1) {
    return singleWorkerRun
  }
  return {
    workers,
    fullyParallel: true,
    isolateHarnessWorkers: true,
    webServerEnabled: false,
  }
}
