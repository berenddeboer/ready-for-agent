/**
 * Per-Playwright-worker live Harness identity (issue #1000).
 *
 * UI-history runs more than one Playwright worker. Each worker talks to its
 * own Harness process: distinct listen port, GraphQL origin, and supervisor
 * state file. Live-Forge stays on worker 0 / a single webServer.
 */

export const E2E_HARNESS_DEFAULT_BASE_PORT = 4174

export type LiveHarnessWorkerIdentity = {
  readonly workerIndex: number
  readonly port: number
  readonly baseUrl: string
  readonly graphqlUrl: string
  readonly stateFileName: string
}

const parseNonNegativeInteger = (
  raw: string | undefined,
  fallback: number,
  label: string,
): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${label} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    )
  }
  return parsed
}

const parseBasePort = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") {
    return E2E_HARNESS_DEFAULT_BASE_PORT
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `E2E_HARNESS_PORT must be a TCP port, got ${JSON.stringify(raw)}`,
    )
  }
  return parsed
}

/** Playwright worker slot. Ignores a leaked supervisor index. */
export const resolvePlaywrightParallelIndex = (
  env: Record<string, string | undefined> = process.env,
): number =>
  parseNonNegativeInteger(env.TEST_PARALLEL_INDEX, 0, "TEST_PARALLEL_INDEX")

/** Supervisor slot (`E2E_HARNESS_WORKER_INDEX`) wins over Playwright's index. */
export const resolveLiveHarnessWorkerIndex = (
  env: Record<string, string | undefined> = process.env,
): number =>
  parseNonNegativeInteger(
    env.E2E_HARNESS_WORKER_INDEX ?? env.TEST_PARALLEL_INDEX,
    0,
    "E2E_HARNESS_WORKER_INDEX",
  )

export const liveHarnessStateFileName = (workerIndex: number): string =>
  `.live-harness-state.${workerIndex}.json`

export const liveHarnessWorkerIdentity = (input: {
  readonly workerIndex: number
  readonly basePort?: number
}): LiveHarnessWorkerIdentity => {
  const basePort = input.basePort ?? E2E_HARNESS_DEFAULT_BASE_PORT
  const port = basePort + input.workerIndex
  const baseUrl = `http://127.0.0.1:${port}`
  return {
    workerIndex: input.workerIndex,
    port,
    baseUrl,
    graphqlUrl: `${baseUrl}/graphql`,
    stateFileName: liveHarnessStateFileName(input.workerIndex),
  }
}

/**
 * Playwright-side slot identity: explicit worker index plus the env base
 * port. Ignores `E2E_HARNESS_WORKER_INDEX` so an ambient supervisor index
 * cannot pin every worker to one Harness.
 */
export const liveHarnessWorkerIdentityForSlot = (input: {
  readonly workerIndex: number
  readonly env?: Record<string, string | undefined>
}): LiveHarnessWorkerIdentity =>
  liveHarnessWorkerIdentity({
    workerIndex: input.workerIndex,
    basePort: parseBasePort((input.env ?? process.env).E2E_HARNESS_PORT),
  })

/** Listen port and state file for this supervisor or Playwright worker. */
export const liveHarnessSupervisorBindings = (
  env: Record<string, string | undefined> = process.env,
): LiveHarnessWorkerIdentity =>
  liveHarnessWorkerIdentityForSlot({
    workerIndex: resolveLiveHarnessWorkerIndex(env),
    env,
  })
