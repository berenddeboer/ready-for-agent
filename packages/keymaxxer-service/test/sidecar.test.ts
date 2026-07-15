import { Effect } from "effect"
import {
  KeymaxxerService,
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
    expect(parseSidecarUrl("http://127.0.0.1:5032/abcXYZ0123/mcp").url).toBe(
      "http://127.0.0.1:5032/abcXYZ0123/mcp",
    )
    expect(() => parseSidecarUrl("http://127.0.0.1:5032")).toThrow()
    expect(() => parseSidecarUrl("http://127.0.0.1:5032/mcp")).toThrow()
    expect(() => parseSidecarUrl("http://localhost:5032/cap/mcp")).toThrow()
  })
})

describe("sidecar-backed Keymaxxer layer", () => {
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
        }).pipe(Effect.provide(sidecarKeymaxxerLayer("http://127.0.0.1:5032"))),
      ),
    ).rejects.toMatchObject({
      _tag: "KeymaxxerError",
      operation: "configure",
    })
  })
})
