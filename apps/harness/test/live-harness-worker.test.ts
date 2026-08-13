import { liveHarnessStateFilePath } from "../e2e/support/live-harness-control.ts"
import {
  liveHarnessStateFileName,
  liveHarnessSupervisorBindings,
  liveHarnessWorkerIdentity,
  liveHarnessWorkerIdentityForSlot,
  resolveLiveHarnessWorkerIndex,
  resolvePlaywrightParallelIndex,
} from "../e2e/support/live-harness-worker.ts"
import { describe, expect, test } from "bun:test"

describe("liveHarnessWorkerIdentity (issue #1000)", () => {
  test("worker 0 keeps the historical listen port and GraphQL origin", () => {
    expect(liveHarnessWorkerIdentity({ workerIndex: 0 })).toEqual({
      workerIndex: 0,
      port: 4174,
      baseUrl: "http://127.0.0.1:4174",
      graphqlUrl: "http://127.0.0.1:4174/graphql",
      stateFileName: ".live-harness-state.0.json",
    })
  })

  test("later workers get a distinct port, origin, and state file", () => {
    const worker0 = liveHarnessWorkerIdentity({ workerIndex: 0 })
    const worker1 = liveHarnessWorkerIdentity({ workerIndex: 1 })

    expect(worker1).toEqual({
      workerIndex: 1,
      port: 4175,
      baseUrl: "http://127.0.0.1:4175",
      graphqlUrl: "http://127.0.0.1:4175/graphql",
      stateFileName: ".live-harness-state.1.json",
    })
    expect(worker1.port).not.toBe(worker0.port)
    expect(worker1.baseUrl).not.toBe(worker0.baseUrl)
    expect(worker1.graphqlUrl).not.toBe(worker0.graphqlUrl)
    expect(worker1.stateFileName).not.toBe(worker0.stateFileName)
  })

  test("an explicit base port shifts every worker without colliding", () => {
    expect(
      liveHarnessWorkerIdentity({ workerIndex: 2, basePort: 5000 }),
    ).toEqual({
      workerIndex: 2,
      port: 5002,
      baseUrl: "http://127.0.0.1:5002",
      graphqlUrl: "http://127.0.0.1:5002/graphql",
      stateFileName: ".live-harness-state.2.json",
    })
  })
})

describe("resolveLiveHarnessWorkerIndex", () => {
  test("prefers the supervisor worker index over Playwright's parallel index", () => {
    expect(
      resolveLiveHarnessWorkerIndex({
        E2E_HARNESS_WORKER_INDEX: "2",
        TEST_PARALLEL_INDEX: "1",
      }),
    ).toBe(2)
  })

  test("uses Playwright TEST_PARALLEL_INDEX in the step worker", () => {
    expect(
      resolveLiveHarnessWorkerIndex({
        TEST_PARALLEL_INDEX: "3",
      }),
    ).toBe(3)
  })

  test("Playwright slot index ignores a leaked supervisor worker index", () => {
    expect(
      resolvePlaywrightParallelIndex({
        E2E_HARNESS_WORKER_INDEX: "0",
        TEST_PARALLEL_INDEX: "3",
      }),
    ).toBe(3)
  })

  test("defaults to worker 0 so live-Forge and a single webServer stay put", () => {
    expect(resolveLiveHarnessWorkerIndex({})).toBe(0)
  })
})

describe("liveHarnessSupervisorBindings", () => {
  test("binds the supervisor listen port and state file to the worker slot", () => {
    const bindings = liveHarnessSupervisorBindings({
      E2E_HARNESS_PORT: "4174",
      E2E_HARNESS_WORKER_INDEX: "1",
    })

    expect(bindings.port).toBe(4175)
    expect(liveHarnessStateFileName(bindings.workerIndex)).toBe(
      ".live-harness-state.1.json",
    )
  })
})

describe("liveHarnessWorkerIdentityForSlot", () => {
  test("honors E2E_HARNESS_PORT the same way the supervisor does", () => {
    const env = {
      E2E_HARNESS_PORT: "5000",
      E2E_HARNESS_WORKER_INDEX: "2",
    }

    expect(liveHarnessWorkerIdentityForSlot({ workerIndex: 2, env })).toEqual(
      liveHarnessSupervisorBindings(env),
    )
  })

  test("does not let an ambient supervisor index steal another worker's slot", () => {
    expect(
      liveHarnessWorkerIdentityForSlot({
        workerIndex: 1,
        env: {
          E2E_HARNESS_PORT: "5000",
          E2E_HARNESS_WORKER_INDEX: "0",
          TEST_PARALLEL_INDEX: "1",
        },
      }),
    ).toEqual({
      workerIndex: 1,
      port: 5001,
      baseUrl: "http://127.0.0.1:5001",
      graphqlUrl: "http://127.0.0.1:5001/graphql",
      stateFileName: ".live-harness-state.1.json",
    })
  })
})

describe("liveHarnessStateFilePath", () => {
  test("step-side default follows Playwright slot, not a leaked supervisor index", () => {
    const previousWorker = process.env.E2E_HARNESS_WORKER_INDEX
    const previousParallel = process.env.TEST_PARALLEL_INDEX
    process.env.E2E_HARNESS_WORKER_INDEX = "0"
    process.env.TEST_PARALLEL_INDEX = "2"
    try {
      expect(liveHarnessStateFilePath()).toMatch(
        /\.live-harness-state\.2\.json$/,
      )
    } finally {
      if (previousWorker === undefined) {
        delete process.env.E2E_HARNESS_WORKER_INDEX
      } else {
        process.env.E2E_HARNESS_WORKER_INDEX = previousWorker
      }
      if (previousParallel === undefined) {
        delete process.env.TEST_PARALLEL_INDEX
      } else {
        process.env.TEST_PARALLEL_INDEX = previousParallel
      }
    }
  })
})
