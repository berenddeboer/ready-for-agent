import { Effect } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerToolClient,
  keymaxxerEnvironment,
  keymaxxerMcpCommand,
  mcpKeymaxxerLayer,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
})

describe("MCP Keymaxxer layer", () => {
  test("caches hits and refreshes misses", async () => {
    let listCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async ({ name }) => {
        expect(name).toBe("keymaxxer_list")
        listCalls += 1
        return textResult(
          JSON.stringify(
            listCalls === 1
              ? [{ name: "EXISTING_SECRET" }]
              : [{ name: "EXISTING_SECRET" }, { name: "LATER_SECRET" }],
          ),
        )
      },
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        const existing = yield* keymaxxer.hasSecret("EXISTING_SECRET")
        const existingAgain = yield* keymaxxer.hasSecret("EXISTING_SECRET")
        const later = yield* keymaxxer.hasSecret("LATER_SECRET")
        return { existing, existingAgain, later }
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({
      existing: true,
      existingAgain: true,
      later: true,
    })
    expect(listCalls).toBe(2)
  })

  test("updates the cache after add and treats cancellation as false", async () => {
    const calls: string[] = []
    const client: KeymaxxerToolClient = {
      callTool: async ({ arguments: input, name }) => {
        calls.push(name)
        if (name === "keymaxxer_list") return textResult("[]")
        if (input.name === "CANCELLED_SECRET") {
          return textResult("Secret entry cancelled", true)
        }
        return textResult("Secret saved")
      },
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize()
        const added = yield* keymaxxer.addSecret({ name: "NEW_SECRET" })
        const present = yield* keymaxxer.hasSecret("NEW_SECRET")
        const cancelled = yield* keymaxxer.addSecret({
          name: "CANCELLED_SECRET",
        })
        return { added, present, cancelled }
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({ added: true, present: true, cancelled: false })
    expect(calls).toEqual(["keymaxxer_list", "keymaxxer_add", "keymaxxer_add"])
  })

  test("returns non-zero command results with separate output streams", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () =>
        textResult(
          "exit_code: 7\n--- stdout ---\nmachine output\n--- stderr ---\ndiagnostic",
        ),
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* keymaxxer.runWithSecrets({
          command: "gh issue list",
          cwd: "/tmp",
          secrets: ["GITHUB_TOKEN_REPOSITORY"],
          timeoutMs: 1_000,
        })
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({
      exitCode: 7,
      stdout: "machine output",
      stderr: "diagnostic",
    })
  })

  test("prefers structured command results", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () => ({
        content: [{ type: "text", text: "ambiguous legacy output" }],
        structuredContent: {
          exitCode: 3,
          stdout: "structured stdout",
          stderr: "structured stderr",
        },
      }),
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* keymaxxer.runWithSecrets({
          command: "false",
          cwd: "/tmp",
          secrets: ["A_SECRET"],
          timeoutMs: 1,
        })
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({
      exitCode: 3,
      stdout: "structured stdout",
      stderr: "structured stderr",
    })
  })

  test("fails safely when legacy stream delimiters are ambiguous", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () =>
        textResult(
          "exit_code: 0\n--- stdout ---\nok\n--- stderr ---\nfirst\n--- stderr ---\nsecond",
        ),
      close: async () => {},
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(
          keymaxxer.runWithSecrets({
            command: "printf output",
            cwd: "/tmp",
            secrets: ["A_SECRET"],
            timeoutMs: 1,
          }),
        )
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("fails invalid tool output and closes the MCP client", async () => {
    let closed = false
    const client: KeymaxxerToolClient = {
      callTool: async () => textResult("not a command result"),
      close: async () => {
        closed = true
      },
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(
          keymaxxer.runWithSecrets({
            command: "false",
            cwd: "/tmp",
            secrets: ["A_SECRET"],
            timeoutMs: 1,
          }),
        )
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(closed).toBe(true)
  })

  test("does not turn list failures into missing secrets", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () => textResult("vault unavailable", true),
      close: async () => {},
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(keymaxxer.hasSecret("A_SECRET"))
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})

describe("MCP process configuration", () => {
  test("removes GitHub token variables from the child environment", () => {
    expect(
      keymaxxerEnvironment({
        GITHUB_TOKEN: "generic",
        GITHUB_TOKEN_OWNER_REPO: "repository",
        HOME: "/home/test",
      }),
    ).toEqual({ HOME: "/home/test" })
  })

  test("uses an existing explicit Keymaxxer entrypoint", () => {
    expect(keymaxxerMcpCommand({ KEYMAXXER_ENTRYPOINT: "/bin/true" })).toEqual({
      command: "bun",
      args: ["/bin/true", "serve"],
    })
  })
})
