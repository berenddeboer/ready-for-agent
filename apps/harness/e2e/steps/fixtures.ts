import { test as base, createBdd } from "playwright-bdd"
import type { FixtureForge } from "../support/clone-fixture-repo.ts"
import { liveHarnessWorkerIdentityForSlot } from "../support/live-harness-worker.ts"
import { resolvePlaywrightLiveE2eRun } from "../support/playwright-live-e2e-run.ts"
import { startWorkerLiveHarness } from "../support/start-worker-live-harness.ts"

const liveE2eRun = resolvePlaywrightLiveE2eRun(process.env)

export type LiveE2eWorld = {
  fixtureCheckoutPath?: string
  cleanupFixtureCheckout?: () => void
  fixtureForge?: FixtureForge
  fixtureDisplayRepository?: string
  /** Repository Intake CLI scenario state (issue #978). */
  intakeCandidatesResult?: {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly document: unknown
  }
  intakeCandidatesRerunResult?: {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly document: unknown
  }
  intakeIntakeResult?: {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly document: unknown
  }
  intakeStatusResult?: {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly document: unknown
  }
  intakeCreatedWorkItemId?: string
  /** All Work Item ids created by Intake in this scenario (for teardown). */
  intakeCreatedWorkItemIds?: readonly string[]
  intakeRepositoryId?: string
}

type WorkerHarness = {
  readonly baseUrl: string
}

export const test = base.extend<
  { world: LiveE2eWorld },
  { workerHarness: WorkerHarness }
>({
  workerHarness: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright worker fixtures require the object destructuring pattern.
    async ({}, use, testInfo) => {
      if (!liveE2eRun.isolateHarnessWorkers) {
        await use({
          baseUrl: liveHarnessWorkerIdentityForSlot({ workerIndex: 0 }).baseUrl,
        })
        return
      }
      const handle = await startWorkerLiveHarness({
        workerIndex: testInfo.parallelIndex,
      })
      try {
        await use({ baseUrl: handle.identity.baseUrl })
      } finally {
        await handle.stop()
      }
    },
    { scope: "worker", auto: true },
  ],
  baseURL: async ({ workerHarness }, use) => {
    await use(workerHarness.baseUrl)
  },
  world: async ({ page: _page }, use) => {
    const world: LiveE2eWorld = {}
    await use(world)
    world.cleanupFixtureCheckout?.()
  },
})

export const { Given, When, Then } = createBdd(test)
