import { Duration, Effect } from "effect"
import {
  hasOpencodeTaskSubagentActivity,
  observeOpencodeStartupActivity,
} from "../src/lib/startup-activity.js"
import { describe, expect, test } from "bun:test"

const page = (data: ReadonlyArray<unknown>) => ({
  data,
  cursor: { previous: null, next: null },
})

describe("hasOpencodeTaskSubagentActivity", () => {
  test("detects a child session created after the turn started", async () => {
    const startedAfterMs = 1_000
    const active = await hasOpencodeTaskSubagentActivity({
      sessionId: "ses_parent",
      startedAfterMs,
      reader: {
        getServerInfo: async () => ({ version: "2.0.32" }),
        getSession: async () => {
          throw new Error("startup must not load the parent transcript")
        },
        listChildren: async () =>
          page([
            {
              id: "ses_child",
              parentID: "ses_parent",
              time: {
                created: startedAfterMs + 50,
                updated: startedAfterMs + 50,
              },
            },
          ]),
        listMessages: async () => page([]),
      },
    })
    expect(active).toBe(true)
  })

  test("ignores historical child sessions and time_updated-only changes", async () => {
    const startedAfterMs = 5_000
    const active = await hasOpencodeTaskSubagentActivity({
      sessionId: "ses_parent",
      startedAfterMs,
      reader: {
        getServerInfo: async () => ({ version: "2.0.32" }),
        getSession: async () => ({}),
        listChildren: async () =>
          page([
            {
              id: "ses_old_child",
              parentID: "ses_parent",
              time: { created: 100, updated: startedAfterMs + 10 },
            },
          ]),
        listMessages: async () => page([]),
      },
    })
    expect(active).toBe(false)
  })

  test("detects a parent task tool created after the turn started", async () => {
    const startedAfterMs = 2_000
    const active = await hasOpencodeTaskSubagentActivity({
      sessionId: "ses_parent",
      startedAfterMs,
      reader: {
        getServerInfo: async () => ({ version: "2.0.32" }),
        getSession: async () => ({}),
        listChildren: async () => page([]),
        listMessages: async () =>
          page([
            {
              id: "msg_asst",
              type: "assistant",
              time: { created: startedAfterMs + 20 },
              content: [
                {
                  type: "tool",
                  name: "task",
                  state: { status: "running", input: { prompt: "secret" } },
                  time: { created: startedAfterMs + 20 },
                },
              ],
            },
          ]),
      },
    })
    expect(active).toBe(true)
  })

  test("probe errors are not activity", async () => {
    const active = await hasOpencodeTaskSubagentActivity({
      sessionId: "ses_parent",
      startedAfterMs: 1,
      reader: {
        getServerInfo: async () => ({ version: "2.0.32" }),
        getSession: async () => ({}),
        listChildren: async () => {
          throw new Error("network")
        },
        listMessages: async () => page([]),
      },
    })
    expect(active).toBe(false)
  })
})

describe("observeOpencodeStartupActivity", () => {
  test("polls until the probe reports activity and keeps the timeout seam", async () => {
    let polls = 0
    await Effect.runPromise(
      observeOpencodeStartupActivity({
        sessionId: "ses_parent",
        startedAfterMs: 10,
        pollInterval: Duration.millis(5),
        probe: () => {
          polls += 1
          return polls >= 2
        },
      }).pipe(Effect.timeout("1 second")),
    )
    expect(polls).toBeGreaterThanOrEqual(2)
  })
})
