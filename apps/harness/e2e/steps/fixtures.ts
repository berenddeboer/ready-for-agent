import { test as base, createBdd } from "playwright-bdd"
import type { FixtureForge } from "../support/clone-fixture-repo.ts"

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

export const test = base.extend<{ world: LiveE2eWorld }>({
  world: async ({ page: _page }, use) => {
    const world: LiveE2eWorld = {}
    await use(world)
    world.cleanupFixtureCheckout?.()
  },
})

export const { Given, When, Then } = createBdd(test)
