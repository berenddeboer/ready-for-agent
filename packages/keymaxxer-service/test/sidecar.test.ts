import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Cause, Effect, ManagedRuntime, Option } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerToolClient,
  type KeymaxxerUpstreamClient,
  closeStreamableHttpClient,
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
  test("bounds Layer A terminate so a hung DELETE cannot stall dispose", async () => {
    let closeCalls = 0
    let terminateCalls = 0
    let releaseTerminate!: (error?: Error) => void
    const terminateGate = new Promise<void>((resolve, reject) => {
      releaseTerminate = (error) => {
        if (error) reject(error)
        else resolve()
      }
    })
    const transport = {
      terminateSession: async () => {
        terminateCalls += 1
        // Stays pending until close aborts the DELETE (production SDK path).
        await terminateGate
      },
    } as unknown as StreamableHTTPClientTransport
    const client = {
      close: async () => {
        closeCalls += 1
        // Model transport.close() aborting the in-flight terminate fetch.
        releaseTerminate(new Error("The operation was aborted"))
      },
    } as unknown as Client

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const startedAt = Date.now()
      await closeStreamableHttpClient(transport, client, {
        terminateTimeoutMs: 50,
      })
      // Allow a late rejection to surface if not absorbed.
      await Bun.sleep(20)
      const elapsedMs = Date.now() - startedAt

      expect(terminateCalls).toBe(1)
      expect(closeCalls).toBe(1)
      expect(elapsedMs).toBeLessThan(1_000)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("returns after terminate timeout even when close does not settle DELETE", async () => {
    let closeCalls = 0
    const transport = {
      terminateSession: async () => {
        // Never settles — abort after close is ignored (stuck pre-fetch path).
        await new Promise<void>(() => {})
      },
    } as unknown as StreamableHTTPClientTransport
    const client = {
      close: async () => {
        closeCalls += 1
      },
    } as unknown as Client

    const startedAt = Date.now()
    await closeStreamableHttpClient(transport, client, {
      terminateTimeoutMs: 50,
    })
    const elapsedMs = Date.now() - startedAt

    expect(closeCalls).toBe(1)
    expect(elapsedMs).toBeLessThan(500)
  })

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

  test("runtime disposal terminates the Layer A HTTP session without closing upstream", async () => {
    let upstreamCloseCalls = 0
    let upstreamSpawns = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => {
        upstreamSpawns += 1
        return {
          callTool: mockUpstream().callTool,
          close: async () => {
            upstreamCloseCalls += 1
          },
        }
      },
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      expect(facade.activeHttpSessionCount()).toBe(0)

      const runtime = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const keymaxxer = yield* KeymaxxerService
            yield* keymaxxer.initialize
            expect(yield* keymaxxer.hasSecret("PRESENT_SECRET")).toBe(true)
          }),
        )
        expect(facade.activeHttpSessionCount()).toBe(1)
        expect(upstreamSpawns).toBe(1)
      } finally {
        await runtime.dispose()
      }

      expect(facade.activeHttpSessionCount()).toBe(0)
      expect(upstreamCloseCalls).toBe(0)
      expect(upstreamSpawns).toBe(1)
    } finally {
      await facade.stop()
    }
  })

  test("disposing one client leaves another client on the shared unlocked vault session", async () => {
    let upstreamCloseCalls = 0
    let listCalls = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            listCalls += 1
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
          return mockUpstream().callTool({ name, arguments: {} })
        },
        close: async () => {
          upstreamCloseCalls += 1
        },
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const runtimeA = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
      const runtimeB = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
      try {
        // First tool call opens the Layer A HTTP session (initialize is TCP only).
        expect(
          await runtimeA.runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              yield* keymaxxer.initialize
              return yield* keymaxxer.hasSecret("PRESENT_SECRET")
            }),
          ),
        ).toBe(true)
        expect(
          await runtimeB.runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              yield* keymaxxer.initialize
              return yield* keymaxxer.hasSecret("PRESENT_SECRET")
            }),
          ),
        ).toBe(true)
        expect(facade.activeHttpSessionCount()).toBe(2)
        const listsAfterUnlock = listCalls

        await runtimeA.dispose()
        expect(facade.activeHttpSessionCount()).toBe(1)
        expect(upstreamCloseCalls).toBe(0)

        // Second client still uses the shared Layer B unlock. findSecret always
        // refreshes metadata (network list) so this is not a cache-only hit.
        const found = await runtimeB.runPromise(
          Effect.gen(function* () {
            const keymaxxer = yield* KeymaxxerService
            return yield* keymaxxer.findSecret({
              provider: "github",
              account: "acme/widgets",
            })
          }),
        )
        expect(found).toBe("PRESENT_SECRET")
        expect(listCalls).toBeGreaterThan(listsAfterUnlock)
        expect(upstreamCloseCalls).toBe(0)
      } finally {
        await runtimeA.dispose().catch(() => undefined)
        await runtimeB.dispose().catch(() => undefined)
      }

      expect(facade.activeHttpSessionCount()).toBe(0)
      expect(upstreamCloseCalls).toBe(0)
    } finally {
      await facade.stop()
    }
  })

  test("repeated create/use/dispose cycles do not retain Sidecar HTTP sessions", async () => {
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => mockUpstream(),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        const runtime = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
        try {
          await runtime.runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              yield* keymaxxer.initialize
              expect(yield* keymaxxer.hasSecret("PRESENT_SECRET")).toBe(true)
            }),
          )
          expect(facade.activeHttpSessionCount()).toBe(1)
        } finally {
          await runtime.dispose()
        }
        expect(facade.activeHttpSessionCount()).toBe(0)
      }
    } finally {
      await facade.stop()
    }
  })

  test("in-flight responses for a disposed session are abandoned without affecting another session", async () => {
    let releaseRun!: () => void
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const runStarted = Promise.withResolvers<void>()
    let upstreamCloseCalls = 0
    let runCalls = 0
    let listCalls = 0

    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            listCalls += 1
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
          if (name === "keymaxxer_run") {
            runCalls += 1
            runStarted.resolve()
            await runGate
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
        close: async () => {
          upstreamCloseCalls += 1
        },
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const runtimeA = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
      const runtimeB = ManagedRuntime.make(sidecarKeymaxxerLayer(facade.url))
      try {
        expect(
          await runtimeA.runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              yield* keymaxxer.initialize
              return yield* keymaxxer.hasSecret("PRESENT_SECRET")
            }),
          ),
        ).toBe(true)
        expect(
          await runtimeB.runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              yield* keymaxxer.initialize
              return yield* keymaxxer.hasSecret("PRESENT_SECRET")
            }),
          ),
        ).toBe(true)
        expect(facade.activeHttpSessionCount()).toBe(2)
        const listsBeforeOrphan = listCalls

        // Start a dialog-lane run on A and dispose A before it completes.
        // Capture outcome early so dispose interruption is not an unhandled rejection.
        const runAOutcome = runtimeA
          .runPromise(
            Effect.gen(function* () {
              const keymaxxer = yield* KeymaxxerService
              return yield* keymaxxer.runWithSecrets({
                command: "true",
                cwd: "/tmp",
                secrets: ["PRESENT_SECRET"],
                timeoutMs: 30_000,
              })
            }),
          )
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        await runStarted.promise
        await runtimeA.dispose()
        expect(facade.activeHttpSessionCount()).toBe(1)

        // B remains healthy while A's orphaned upstream work may still finish.
        // findSecret always refreshes via keymaxxer_list (post-unlock list bypasses
        // the dialog lane), so this is not a cache-only hasSecret hit.
        const found = await runtimeB.runPromise(
          Effect.gen(function* () {
            const keymaxxer = yield* KeymaxxerService
            return yield* keymaxxer.findSecret({
              provider: "github",
              account: "acme/widgets",
            })
          }),
        )
        expect(found).toBe("PRESENT_SECRET")
        expect(listCalls).toBeGreaterThan(listsBeforeOrphan)

        releaseRun()
        // Disposed session must not deliver a successful domain result.
        const abandoned = await runAOutcome
        expect(abandoned.ok).toBe(false)
        expect(runCalls).toBe(1)
        expect(upstreamCloseCalls).toBe(0)

        // B can still use the vault after the orphaned run settles.
        const runB = await runtimeB.runPromise(
          Effect.gen(function* () {
            const keymaxxer = yield* KeymaxxerService
            return yield* keymaxxer.runWithSecrets({
              command: "true",
              cwd: "/tmp",
              secrets: ["PRESENT_SECRET"],
              timeoutMs: 5_000,
            })
          }),
        )
        expect(runB).toEqual({ exitCode: 0, stdout: "ok", stderr: "" })
        expect(upstreamCloseCalls).toBe(0)
      } finally {
        await runtimeA.dispose().catch(() => undefined)
        await runtimeB.dispose().catch(() => undefined)
      }

      expect(facade.activeHttpSessionCount()).toBe(0)
    } finally {
      await facade.stop()
    }
  })

  test("Effect.provide layer scope release terminates the HTTP session", async () => {
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => mockUpstream(),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      // Effect.provide of a scoped layer releases acquireRelease on completion —
      // the same scope registration Harness ManagedRuntime uses on dispose.
      await Effect.runPromise(
        Effect.gen(function* () {
          const keymaxxer = yield* KeymaxxerService
          yield* keymaxxer.initialize
          expect(yield* keymaxxer.hasSecret("PRESENT_SECRET")).toBe(true)
          expect(facade.activeHttpSessionCount()).toBe(1)
        }).pipe(Effect.provide(sidecarKeymaxxerLayer(facade.url))),
      )
      expect(facade.activeHttpSessionCount()).toBe(0)
    } finally {
      await facade.stop()
    }
  })
})
