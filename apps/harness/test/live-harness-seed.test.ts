import {
  CONTROL_FILES,
  type LiveHarnessState,
} from "../e2e/support/live-harness-control.ts"
import {
  type LiveHarnessSeedControl,
  ensureLiveHarnessPersistence,
  seedLiveHarnessAndRestart,
} from "../e2e/support/live-harness-seed.ts"
import {
  SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT,
  SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS,
  TELEMETRY_FIXTURE,
  sessionTelemetryFixturesArePresent,
} from "../e2e/support/session-telemetry-fixture.ts"
import { describe, expect, test } from "bun:test"

const state: LiveHarnessState = {
  dbPath: "/tmp/e2e-harness.db",
  controlDir: "/tmp/e2e-control",
}

const recordingControl = (): {
  control: LiveHarnessSeedControl
  files: Map<string, string>
  waitCalls: number
} => {
  const files = new Map<string, string>()
  let waitCalls = 0
  const control: LiveHarnessSeedControl = {
    readState: () => state,
    readGeneration: () => 3,
    writeControlFile: (_state, file, contents) => {
      files.set(file, contents)
    },
    waitForRestart: async () => {
      waitCalls += 1
    },
  }
  return {
    get waitCalls() {
      return waitCalls
    },
    control,
    files,
  }
}

describe("ensureLiveHarnessPersistence", () => {
  test("is a no-op when the seed is already present", async () => {
    const recording = recordingControl()

    const outcome = await ensureLiveHarnessPersistence(
      {
        alreadyPresent: async () => true,
        sql: "INSERT INTO repository (id) VALUES ('should-not-write');",
      },
      recording.control,
    )

    expect(outcome).toEqual({ kind: "already-present" })
    expect(recording.files.size).toBe(0)
    expect(recording.waitCalls).toBe(0)
  })

  test("seeds against the stopped database and restarts when missing", async () => {
    const recording = recordingControl()
    const sql = "INSERT INTO work_item (id) VALUES ('wi-missing');"

    const outcome = await ensureLiveHarnessPersistence(
      {
        alreadyPresent: async () => false,
        sql,
      },
      recording.control,
    )

    expect(outcome).toEqual({ kind: "seeded" })
    expect(recording.files.get(CONTROL_FILES.seedSql)).toBe(sql)
    expect(recording.files.get(CONTROL_FILES.restart)).toBe("1")
    expect(recording.waitCalls).toBe(1)
  })
})

describe("seedLiveHarnessAndRestart", () => {
  test("always requests a restart, including empty SQL for readiness-only changes", async () => {
    const recording = recordingControl()

    await seedLiveHarnessAndRestart("", recording.control)

    expect(recording.files.get(CONTROL_FILES.seedSql)).toBe("")
    expect(recording.files.get(CONTROL_FILES.restart)).toBe("1")
    expect(recording.waitCalls).toBe(1)
  })
})

describe("sessionTelemetryFixturesArePresent", () => {
  test("requires the named Work Items and the Completed pagination fillers", () => {
    const named: ReadonlyArray<{ readonly id: string }> =
      SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.map((id) => ({ id }))
    const fillers: ReadonlyArray<{ readonly id: string }> = Array.from(
      {
        length:
          SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT -
          SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.length,
      },
      (_, index) => ({
        id: `wi-01KZD5SESS10NTE0F${String(index + 1).padStart(9, "0")}`,
      }),
    )

    expect(sessionTelemetryFixturesArePresent([])).toBe(false)
    expect(sessionTelemetryFixturesArePresent(named)).toBe(false)
    expect(sessionTelemetryFixturesArePresent([...named, ...fillers])).toBe(
      true,
    )
    expect(
      sessionTelemetryFixturesArePresent(
        named
          .filter((item) => item.id !== TELEMETRY_FIXTURE.completedWorkItemId)
          .concat(fillers),
      ),
    ).toBe(false)
  })
})
