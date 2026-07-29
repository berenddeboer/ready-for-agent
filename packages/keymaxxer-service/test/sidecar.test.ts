import { Cause, Effect, Option } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerToolClient,
  type KeymaxxerUpstreamClient,
  parseSidecarUrl,
  sidecarKeymaxxerLayer,
  startKeymaxxerFacade,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const mockUpstream = (): KeymaxxerUpstreamClient => ({
  callTool: async ({ name, arguments: args }) => {
    if (name === "keymaxxer_list") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                name: "PRESENT_SECRET",
                provider: "github",
                account: "acme/widgets",
              },
            ]),
          },
        ],
      }
    }
    if (name === "keymaxxer_add") {
      return { content: [{ type: "text", text: `added ${String(args.name)}` }] }
    }
    if (name === "keymaxxer_run") {
      return {
        content: [
          {
            type: "text",
            text: "exit_code: 0\n--- stdout ---\nok\n--- stderr ---\n",
          },
        ],
      }
    }
    return { content: [{ type: "text", text: "ok" }] }
  },
  close: async () => {},
})

describe("parseSidecarUrl", () => {
  test("accepts capability MCP URLs and rejects origins without path secret", () => {
    expect(parseSidecarUrl("http://127.0.0.1:6057/abcXYZ0123/mcp").url).toBe(
      "http://127.0.0.1:6057/abcXYZ0123/mcp",
    )
    expect(() => parseSidecarUrl("http://127.0.0.1:6057")).toThrow()
    expect(() => parseSidecarUrl("http://127.0.0.1:6057/mcp")).toThrow()
    expect(() => parseSidecarUrl("http://localhost:6057/cap/mcp")).toThrow()
  })
})

describe("sidecar-backed Keymaxxer layer", () => {
  test("closes a lazily created client exactly once when its layer is released", async () => {
    let closeCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([{ name: "PRESENT_SECRET" }]),
          },
        ],
      }),
      close: async () => {
        closeCalls += 1
        throw new Error("close failed")
      },
    }

    const present = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
        return yield* keymaxxer.hasSecret("PRESENT_SECRET")
      }).pipe(
        Effect.provide(
          sidecarKeymaxxerLayer("http://127.0.0.1:6057/capability/mcp", {
            createClient: async () => client,
            fetch: async () => new Response(null, { status: 404 }),
          }),
        ),
      ),
    )

    expect(present).toBe(true)
    expect(closeCalls).toBe(1)
  })

  test("preserves a failed operation when closing its client also fails", async () => {
    let closeCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async () => {
        throw new Error("request failed")
      },
      close: async () => {
        closeCalls += 1
        throw new Error("close failed")
      },
    }

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(keymaxxer.hasSecret("PRESENT_SECRET"))
      }).pipe(
        Effect.provide(
          sidecarKeymaxxerLayer("http://127.0.0.1:6057/capability/mcp", {
            createClient: async () => client,
            fetch: async () => new Response(null, { status: 404 }),
          }),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(
        Option.getOrThrow(Cause.findErrorOption(exit.cause)),
      ).toMatchObject({
        _tag: "KeymaxxerError",
        operation: "listSecrets",
      })
    }
    expect(closeCalls).toBe(1)
  })

  test("initializes over TCP and runs Keymaxxer tools through Streamable HTTP", async () => {
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => mockUpstream(),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keymaxxer = yield* KeymaxxerService
          yield* keymaxxer.initialize
          const present = yield* keymaxxer.hasSecret("PRESENT_SECRET")
          const found = yield* keymaxxer.findSecret({
            provider: "github",
            account: "acme/widgets",
          })
          const foundMany = yield* keymaxxer.findSecrets([
            { provider: "github", account: "acme/widgets" },
          ])
          const added = yield* keymaxxer.addSecret({ name: "NEW_SECRET" })
          const run = yield* keymaxxer.runWithSecrets({
            command: "true",
            cwd: "/tmp",
            secrets: ["PRESENT_SECRET"],
            timeoutMs: 5_000,
          })
          return { present, found, foundMany, added, run }
        }).pipe(Effect.provide(sidecarKeymaxxerLayer(facade.url))),
      )

      expect(result.present).toBe(true)
      expect(result.found).toBe("PRESENT_SECRET")
      expect(result.foundMany).toEqual(["PRESENT_SECRET"])
      expect(result.added).toBe(true)
      expect(result.run).toEqual({ exitCode: 0, stdout: "ok", stderr: "" })
    } finally {
      await facade.stop()
    }
  })

  test("fails closed on invalid capability URL", async () => {
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* KeymaxxerService
        }).pipe(Effect.provide(sidecarKeymaxxerLayer("http://127.0.0.1:6057"))),
      ),
    ).rejects.toMatchObject({
      _tag: "KeymaxxerError",
      operation: "configure",
    })
  })
})
