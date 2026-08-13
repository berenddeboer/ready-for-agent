/**
 * Start one live-Harness supervisor for a Playwright worker (issue #1000).
 *
 * Used when `E2E_HARNESS_WORKERS` is greater than 1 so Playwright's single
 * `webServer` cannot own the Harness. Each worker gets an isolated database,
 * port, control plane, and Keymaxxer home / Sidecar.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { HARNESS_START_TIMEOUT_MS } from "./constants.ts"
import {
  type LiveHarnessWorkerIdentity,
  liveHarnessWorkerIdentityForSlot,
} from "./live-harness-worker.ts"

const supportDir = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(supportDir, "../..")

export type WorkerLiveHarness = {
  readonly identity: LiveHarnessWorkerIdentity
  readonly stop: () => Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const graphqlReachable = async (graphqlUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(graphqlUrl, {
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

const stopChild = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.killed) {
      done()
      return
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 10_000)
    child.once("exit", () => {
      clearTimeout(timer)
      done()
    })
    child.kill("SIGTERM")
  })

export const startWorkerLiveHarness = async (input: {
  readonly workerIndex: number
}): Promise<WorkerLiveHarness> => {
  const identity = liveHarnessWorkerIdentityForSlot({
    workerIndex: input.workerIndex,
  })
  const child = spawn(
    "bun",
    [
      "--conditions",
      "@ready-for-agent/source",
      "e2e/support/start-live-harness.ts",
    ],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        E2E_HARNESS_WORKER_INDEX: String(input.workerIndex),
      },
      stdio: "inherit",
    },
  )

  let exitError: Error | undefined
  child.once("exit", (code, signal) => {
    if (exitError !== undefined) {
      return
    }
    exitError = new Error(
      `Live Harness supervisor for worker ${String(input.workerIndex)} exited during start (code ${String(code)}, signal ${String(signal)})`,
    )
  })

  const deadline = Date.now() + HARNESS_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitError !== undefined) {
      throw exitError
    }
    if (await graphqlReachable(identity.graphqlUrl)) {
      return {
        identity,
        stop: () => stopChild(child),
      }
    }
    await sleep(250)
  }

  await stopChild(child)
  throw new Error(
    `Live Harness GraphQL did not become reachable for worker ${String(input.workerIndex)} at ${identity.graphqlUrl}`,
  )
}
