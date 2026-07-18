import { Effect } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerToolClient,
  isKeymaxxerAvailable,
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

  test("finds a secret by provider and account metadata", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () =>
        textResult(
          JSON.stringify([
            {
              name: "GITHUB_TOKEN_PROCESSFOCUS_MONOREPO",
              provider: "github",
              account: "processfocus/monorepo",
            },
          ]),
        ),
      close: async () => {},
    }

    const name = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* keymaxxer.findSecret({
          provider: "GitHub",
          account: "ProcessFocus/Monorepo",
        })
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(name).toBe("GITHUB_TOKEN_PROCESSFOCUS_MONOREPO")
  })

  test("finds multiple secrets with one vault listing", async () => {
    let listCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async () => {
        listCalls += 1
        return textResult(
          JSON.stringify([
            { name: "FIRST_TOKEN", provider: "github", account: "acme/one" },
            { name: "SECOND_TOKEN", provider: "github", account: "acme/two" },
          ]),
        )
      },
      close: async () => {},
    }

    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* keymaxxer.findSecrets([
          { provider: "github", account: "acme/one" },
          { provider: "github", account: "acme/two" },
          { provider: "github", account: "acme/missing" },
        ])
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(names).toEqual(["FIRST_TOKEN", "SECOND_TOKEN", null])
    expect(listCalls).toBe(1)
  })

  test("refreshes metadata before each secret lookup", async () => {
    let listCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async () => {
        listCalls += 1
        return textResult(
          JSON.stringify([
            {
              name: listCalls === 1 ? "OLD_TOKEN" : "RENAMED_TOKEN",
              provider: "github",
              account: "acme/widgets",
            },
          ]),
        )
      },
      close: async () => {},
    }

    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        const first = yield* keymaxxer.findSecret({
          provider: "github",
          account: "acme/widgets",
        })
        const second = yield* keymaxxer.findSecret({
          provider: "github",
          account: "acme/widgets",
        })
        return [first, second]
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(names).toEqual(["OLD_TOKEN", "RENAMED_TOKEN"])
    expect(listCalls).toBe(2)
  })

  test("rejects multiple secrets for the same provider and account", async () => {
    const client: KeymaxxerToolClient = {
      callTool: async () =>
        textResult(
          JSON.stringify([
            {
              name: "FIRST_TOKEN",
              provider: "github",
              account: "acme/widgets",
            },
            {
              name: "SECOND_TOKEN",
              provider: "github",
              account: "acme/widgets",
            },
          ]),
        ),
      close: async () => {},
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(
          keymaxxer.findSecret({
            provider: "github",
            account: "acme/widgets",
          }),
        )
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("refreshes user-edited metadata after add and treats cancellation as false", async () => {
    const calls: string[] = []
    let added = false
    const client: KeymaxxerToolClient = {
      callTool: async ({ arguments: input, name }) => {
        calls.push(name)
        if (name === "keymaxxer_list") {
          return textResult(
            JSON.stringify(
              added
                ? [
                    {
                      name: "EDITED_SECRET",
                      provider: "github",
                      account: "edited/repository",
                    },
                  ]
                : [],
            ),
          )
        }
        if (input.name === "CANCELLED_SECRET") {
          return textResult("Secret entry cancelled", true)
        }
        added = true
        return textResult("Secret saved")
      },
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
        const wasAdded = yield* keymaxxer.addSecret({
          name: "SUGGESTED_SECRET",
          provider: "github",
          account: "suggested/repository",
        })
        const actualName = yield* keymaxxer.findSecret({
          provider: "github",
          account: "edited/repository",
        })
        const cancelled = yield* keymaxxer.addSecret({
          name: "CANCELLED_SECRET",
        })
        return { wasAdded, actualName, cancelled }
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({
      wasAdded: true,
      actualName: "EDITED_SECRET",
      cancelled: false,
    })
    expect(calls).toEqual([
      "keymaxxer_list",
      "keymaxxer_add",
      "keymaxxer_list",
      "keymaxxer_list",
      "keymaxxer_add",
    ])
  })

  test("removes a secret by name", async () => {
    const calls: string[] = []
    let secrets = [
      {
        name: "GITHUB_TOKEN_ACME_WIDGETS",
        provider: "github",
        account: "acme/widgets",
      },
    ]
    const client: KeymaxxerToolClient = {
      callTool: async (input) => {
        calls.push(input.name)
        if (input.name === "keymaxxer_list") {
          return textResult(JSON.stringify(secrets))
        }
        if (input.name === "keymaxxer_rm") {
          secrets = secrets.filter(
            (secret) => secret.name !== input.arguments.name,
          )
          return textResult(`Removed '${input.arguments.name}'.`)
        }
        return textResult("unexpected", true)
      },
      close: async () => {},
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
        const removed = yield* keymaxxer.removeSecret(
          "GITHUB_TOKEN_ACME_WIDGETS",
        )
        const remaining = yield* keymaxxer.hasSecret(
          "GITHUB_TOKEN_ACME_WIDGETS",
        )
        return { removed, remaining }
      }).pipe(
        Effect.provide(mcpKeymaxxerLayer({ createClient: async () => client })),
      ),
    )

    expect(result).toEqual({ removed: true, remaining: false })
    expect(calls).toEqual([
      "keymaxxer_list",
      "keymaxxer_rm",
      "keymaxxer_list",
      "keymaxxer_list",
    ])
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

  test("uses Bun for an existing source Keymaxxer entrypoint", () => {
    expect(
      keymaxxerMcpCommand(
        { KEYMAXXER_ENTRYPOINT: "/custom/keymaxxer/index.ts" },
        (path) => path === "/custom/keymaxxer/index.ts",
        () => false,
      ),
    ).toEqual({
      command: "bun",
      args: ["/custom/keymaxxer/index.ts", "serve"],
    })
  })

  test("executes a valid executable KEYMAXXER_ENTRYPOINT directly", () => {
    expect(
      keymaxxerMcpCommand(
        { KEYMAXXER_ENTRYPOINT: "/usr/local/bin/keymaxxer" },
        (path) => path === "/usr/local/bin/keymaxxer",
        (path) => path === "/usr/local/bin/keymaxxer",
      ),
    ).toEqual({
      command: "/usr/local/bin/keymaxxer",
      args: ["serve"],
    })
  })

  test("uses keymaxxer on PATH when entrypoint is unset", () => {
    expect(
      keymaxxerMcpCommand(
        {},
        () => true,
        () => false,
      ),
    ).toEqual({
      command: "keymaxxer",
      args: ["serve"],
    })
  })

  test("never selects a hardcoded contrib filesystem path", () => {
    const contrib =
      "/home/berend/src/contrib/keymaxxer/packages/cli/src/index.ts"
    expect(
      keymaxxerMcpCommand(
        {},
        (path) => path === contrib,
        () => false,
      ),
    ).toEqual({
      command: "keymaxxer",
      args: ["serve"],
    })
  })

  test("falls back to PATH when entrypoint is set but missing", () => {
    expect(
      keymaxxerMcpCommand(
        { KEYMAXXER_ENTRYPOINT: "/missing/keymaxxer" },
        () => false,
        () => false,
      ),
    ).toEqual({
      command: "keymaxxer",
      args: ["serve"],
    })
  })

  test("reports Keymaxxer unavailable when no entrypoint or binary exists", () => {
    expect(
      isKeymaxxerAvailable(
        {},
        () => false,
        () => false,
      ),
    ).toBe(false)
  })

  test("reports Keymaxxer available from either source", () => {
    expect(
      isKeymaxxerAvailable(
        { KEYMAXXER_ENTRYPOINT: "/custom/keymaxxer/index.ts" },
        () => true,
        () => false,
      ),
    ).toBe(true)
    expect(
      isKeymaxxerAvailable(
        {},
        () => false,
        () => true,
      ),
    ).toBe(true)
  })
})
