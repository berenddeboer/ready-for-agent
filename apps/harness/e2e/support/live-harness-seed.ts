/**
 * Idempotent live-e2e persistence seeds (issue #994).
 *
 * SQL still goes through the supervisor's stopped-database control plane, but
 * a seed is applied only when the caller reports the rows missing. Re-seeding
 * is a no-op for that live Harness process; restart happens only when a write
 * against the stopped database is required. Catalog-only Agent Model and
 * Claude readiness changes keep calling {@link seedLiveHarnessAndRestart}
 * because those scenarios need a new child process.
 */

import { E2E_GRAPHQL_URL } from "./constants.ts"
import {
  CONTROL_FILES,
  type LiveHarnessState,
  readGeneration,
  readLiveHarnessState,
  writeControlFile,
} from "./live-harness-control.ts"

export type LiveHarnessPersistenceOutcome =
  | { readonly kind: "already-present" }
  | { readonly kind: "seeded" }

export type LiveHarnessSeedControl = {
  readonly readState: () => LiveHarnessState
  readonly readGeneration: (state: LiveHarnessState) => number
  readonly writeControlFile: (
    state: LiveHarnessState,
    file: (typeof CONTROL_FILES)[keyof typeof CONTROL_FILES],
    contents: string,
  ) => void
  readonly waitForRestart: (input: {
    readonly state: LiveHarnessState
    readonly generationBefore: number
  }) => Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollUntil = async (
  probe: () => boolean | Promise<boolean>,
  options: {
    readonly timeoutMs: number
    readonly intervalMs: number
    readonly message: string
  },
): Promise<void> => {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) {
      return
    }
    await sleep(options.intervalMs)
  }
  throw new Error(options.message)
}

const liveHarnessGraphqlReachable = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health }" }),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as {
      data?: { health?: boolean }
    }
    return payload.data?.health === true
  } catch {
    return false
  }
}

const defaultControl: LiveHarnessSeedControl = {
  readState: readLiveHarnessState,
  readGeneration,
  writeControlFile,
  waitForRestart: async ({ state, generationBefore }) => {
    await pollUntil(() => readGeneration(state) > generationBefore, {
      timeoutMs: 60_000,
      intervalMs: 250,
      message: `Live Harness did not restart after seed (generation still ${String(generationBefore)})`,
    })
    await pollUntil(liveHarnessGraphqlReachable, {
      timeoutMs: 120_000,
      intervalMs: 500,
      message: "Live Harness GraphQL did not become reachable after restart",
    })
  },
}

/**
 * Apply SQL against the stopped Harness database and wait for a new child.
 * Use when the write cannot happen while the process holds the file, or when
 * a restart is itself the behavior under test.
 */
export const seedLiveHarnessAndRestart = async (
  sql: string,
  control: LiveHarnessSeedControl = defaultControl,
): Promise<void> => {
  const state = control.readState()
  const generationBefore = control.readGeneration(state)
  control.writeControlFile(state, CONTROL_FILES.seedSql, sql)
  control.writeControlFile(state, CONTROL_FILES.restart, "1")
  await control.waitForRestart({ state, generationBefore })
}

/**
 * Seed live-Harness persistence if the rows are not already present.
 * Restarts only when a write against the stopped database is required.
 */
export const ensureLiveHarnessPersistence = async (
  input: {
    readonly alreadyPresent: () => Promise<boolean>
    readonly sql: string
  },
  control: LiveHarnessSeedControl = defaultControl,
): Promise<LiveHarnessPersistenceOutcome> => {
  if (await input.alreadyPresent()) {
    return { kind: "already-present" }
  }
  await seedLiveHarnessAndRestart(input.sql, control)
  return { kind: "seeded" }
}
