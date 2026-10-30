import { Effect, ManagedRuntime } from "effect"
import {
  OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC,
  OPENCODE_V2_MALFORMED_DIAGNOSTIC,
  OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
  OPENCODE_V2_TRANSIENT_DIAGNOSTIC,
} from "../src/lib/opencode-v2-compatibility.js"
import type { OpencodeV2Reader } from "../src/lib/opencode-v2-read.js"
import {
  OpencodeSessionStore,
  OpencodeSessionStoreLive,
} from "../src/lib/session-store.js"
import { describe, expect, test } from "bun:test"

const created = Date.parse("2026-07-14T08:00:00.000Z")
const updated = Date.parse("2026-07-14T09:00:00.000Z")

const sessionInfo = {
  id: "ses_fixture",
  projectID: "proj",
  model: { id: "gpt-5.5", providerID: "openai", variant: "xhigh" },
  cost: 1.25,
  tokens: {
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 50, write: 10 },
  },
  time: { created, updated },
  location: { directory: "/tmp" },
}

const user = (id: string, at: number) => ({
  id,
  type: "user",
  time: { created: at },
  text: "prompt",
})

const assistant = (
  id: string,
  at: number,
  content: ReadonlyArray<unknown>,
) => ({
  id,
  type: "assistant",
  time: { created: at },
  agent: "build",
  model: { id: "gpt-5.5", providerID: "openai" },
  content,
})

const text = (value: string) => ({ type: "text", text: value })

const tool = (name: string, status: string, at: number) => ({
  type: "tool",
  id: `tool_${name}`,
  name,
  state: {
    status,
    input: { secret: "do-not-copy", command: "x".repeat(50_000) },
    content: [{ type: "text", text: "huge payload" }],
  },
  time: { created: at },
})

const reader = (
  impl: Partial<OpencodeV2Reader> & Pick<OpencodeV2Reader, "getSession">,
): OpencodeV2Reader => ({
  getServerInfo: async () => ({ version: "2.0.32" }),
  listMessages: async () => ({
    data: [],
    cursor: { previous: null, next: null },
  }),
  listChildren: async () => ({
    data: [],
    cursor: { previous: null, next: null },
  }),
  ...impl,
})

const run = async <A>(
  storeReader: OpencodeV2Reader,
  read: (store: OpencodeSessionStore["Service"]) => Effect.Effect<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(
    OpencodeSessionStoreLive({ reader: storeReader }),
  )
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* OpencodeSessionStore
        return yield* read(store)
      }),
    )
  } finally {
    await runtime.dispose()
  }
}

describe("OpencodeSessionStore V2", () => {
  test("reads Session.Info rollup and does not sum message tokens", async () => {
    const session = await run(
      reader({
        getSession: async () => sessionInfo,
        listMessages: async () => ({
          data: [assistant("msg_asst", updated, [text("ignored for totals")])],
          cursor: { previous: null, next: null },
        }),
      }),
      (store) => store.getSession("ses_fixture"),
    )
    expect(session).toEqual({
      id: "ses_fixture",
      availability: "available",
      diagnostic: null,
      model: { providerId: "openai", id: "gpt-5.5", variant: "xhigh" },
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cacheRead: 50,
        cacheWrite: 10,
      },
      cost: 1.25,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T09:00:00.000Z",
    })
  })

  test("returns MISSING for SessionNotFoundError", async () => {
    const session = await run(
      reader({
        getSession: async () => {
          throw { _tag: "SessionNotFoundError", name: "SessionNotFoundError" }
        },
      }),
      (store) => store.getSession("ses_gone"),
    )
    expect(session.availability).toBe("missing")
    expect(session.diagnostic).toBeNull()
    expect(session.tokens).toBeNull()
  })

  test("authentication failure is persistent and not a transient-only retry", async () => {
    const session = await run(
      reader({
        getSession: async () => {
          throw { _tag: "UnauthorizedError", name: "UnauthorizedError" }
        },
      }),
      (store) => store.getSession("ses_fixture"),
    )
    expect(session.availability).toBe("unavailable")
    expect(session.diagnostic).toBe(OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC)
    expect(session.diagnostic).not.toBe(OPENCODE_V2_TRANSIENT_DIAGNOSTIC)
  })

  test("malformed Session.Info is not a transient retry", async () => {
    const session = await run(
      reader({ getSession: async () => ({ id: "ses_fixture" }) }),
      (store) => store.getSession("ses_fixture"),
    )
    expect(session.availability).toBe("unavailable")
    expect(session.diagnostic).toBe(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
    expect(session.diagnostic).not.toContain("V1 fallback")
    expect(session.diagnostic).not.toContain("supported V2")
  })

  test("Retry rediscovers after the previous OpenCode endpoint fails", async () => {
    let connects = 0
    const runtime = ManagedRuntime.make(
      OpencodeSessionStoreLive({
        connect: async () => {
          connects += 1
          if (connects === 1) {
            return {
              kind: "ready",
              reader: reader({
                getSession: async () => {
                  throw new Error("connect ECONNREFUSED")
                },
              }),
            }
          }
          return {
            kind: "ready",
            reader: reader({
              getSession: async () => sessionInfo,
            }),
          }
        },
      }),
    )
    try {
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getSession("ses_fixture")
        }),
      )
      const second = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getSession("ses_fixture")
        }),
      )
      expect(connects).toBe(2)
      expect(first.availability).toBe("unavailable")
      expect(first.diagnostic).toBe(OPENCODE_V2_TRANSIENT_DIAGNOSTIC)
      expect(second.availability).toBe("available")
      expect(second.tokens?.input).toBe(100)
    } finally {
      await runtime.dispose()
    }
  })

  test("transport failure stays transient so Retry can recover", async () => {
    let calls = 0
    const storeReader = reader({
      getSession: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error("fetch failed")
        }
        return sessionInfo
      },
    })
    const first = await run(storeReader, (store) =>
      store.getSession("ses_fixture"),
    )
    const second = await run(storeReader, (store) =>
      store.getSession("ses_fixture"),
    )
    expect(first.availability).toBe("unavailable")
    expect(first.diagnostic).toBe(OPENCODE_V2_TRANSIENT_DIAGNOSTIC)
    expect(second.availability).toBe("available")
    expect(second.tokens?.input).toBe(100)
  })

  test("service-missing connect result is distinct from a missing session", async () => {
    const runtime = ManagedRuntime.make(
      OpencodeSessionStoreLive({
        connect: async () => ({
          kind: "unavailable",
          persistence: "transient",
          diagnostic: OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
        }),
      }),
    )
    const session = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* OpencodeSessionStore
        return yield* store.getSession("ses_any")
      }),
    )
    await runtime.dispose()
    expect(session.availability).toBe("unavailable")
    expect(session.diagnostic).toBe(OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC)
    expect(session.diagnostic).not.toContain("no longer has this Session")
  })

  test("reads the latest Agent Turn Tail without tool payloads or child sessions", async () => {
    const oldAt = Date.parse("2026-08-18T12:00:02.000Z")
    const userAt = Date.parse("2026-08-18T12:00:04.000Z")
    const toolAt = Date.parse("2026-08-18T12:00:05.000Z")
    const textAt = Date.parse("2026-08-18T12:00:06.000Z")
    const tail = await run(
      reader({
        getSession: async () => sessionInfo,
        listMessages: async () => ({
          data: [
            assistant("msg_new", textAt, [
              tool("bun test", "error", toolAt),
              text("tests failed"),
            ]),
            user("msg_user_2", userAt),
            assistant("msg_old", oldAt, [
              text("old turn"),
              tool("read", "completed", oldAt),
            ]),
          ],
          cursor: { previous: null, next: null },
        }),
        listChildren: async () => {
          throw new Error("tail must not list child sessions")
        },
      }),
      (store) => store.getTail("ses_fixture"),
    )
    expect(tail.availability).toBe("available")
    expect(tail.jumpHint).toBe(false)
    expect(tail.items).toEqual([
      {
        kind: "tool",
        name: "bun test",
        status: "error",
        at: "2026-08-18T12:00:05.000Z",
      },
      {
        kind: "assistant_text",
        text: "tests failed",
        truncated: false,
        at: "2026-08-18T12:00:06.000Z",
      },
    ])
    expect(JSON.stringify(tail)).not.toContain("do-not-copy")
    expect(JSON.stringify(tail)).not.toContain("huge payload")
  })

  test("paginates newest-first until the user boundary", async () => {
    const cursors: Array<string | undefined> = []
    const tail = await run(
      reader({
        getSession: async () => sessionInfo,
        listMessages: async (input) => {
          cursors.push(input.cursor)
          if (input.cursor === undefined) {
            return {
              data: [
                assistant("msg_new", Date.parse("2026-08-18T12:00:06.000Z"), [
                  text("page one"),
                ]),
              ],
              cursor: { previous: null, next: "older" },
            }
          }
          return {
            data: [user("msg_user", Date.parse("2026-08-18T12:00:04.000Z"))],
            cursor: { previous: null, next: "older-still" },
          }
        },
      }),
      (store) => store.getTail("ses_fixture"),
    )
    expect(cursors).toEqual([undefined, "older"])
    expect(tail.items).toEqual([
      {
        kind: "assistant_text",
        text: "page one",
        truncated: false,
        at: "2026-08-18T12:00:06.000Z",
      },
    ])
  })

  test("returns empty tail with jumpHint when the latest turn has no activity", async () => {
    const tail = await run(
      reader({
        getSession: async () => sessionInfo,
        listMessages: async () => ({
          data: [user("msg_user", Date.parse("2026-08-18T12:00:03.000Z"))],
          cursor: { previous: null, next: null },
        }),
      }),
      (store) => store.getTail("ses_fixture"),
    )
    expect(tail.availability).toBe("available")
    expect(tail.items).toEqual([])
    expect(tail.jumpHint).toBe(true)
  })
})
