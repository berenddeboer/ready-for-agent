import { Effect } from "effect"
import {
  KeymaxxerError,
  KeymaxxerService,
  type KeymaxxerServiceShape,
  createKeymaxxerSidecarFetch,
  sidecarKeymaxxerLayer,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const fakeService = (
  overrides: Partial<KeymaxxerServiceShape> = {},
): KeymaxxerServiceShape => ({
  initialize: () => Effect.void,
  hasSecret: () => Effect.succeed(false),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () =>
    Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" }),
  ...overrides,
})

const post = (url: URL, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("Keymaxxer Sidecar protocol", () => {
  test("health is versioned and does not initialize MCP", async () => {
    let initializeCalls = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createKeymaxxerSidecarFetch(
        fakeService({
          initialize: () =>
            Effect.sync(() => {
              initializeCalls += 1
            }),
        }),
      ),
    })

    try {
      const response = await fetch(new URL("/health", server.url))
      expect(await response.json()).toEqual({
        status: "ok",
        protocolVersion: 1,
      })
      expect(initializeCalls).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test("deduplicates initialization and retries after failure", async () => {
    let initializeCalls = 0
    const service = fakeService({
      initialize: () =>
        Effect.suspend(() => {
          initializeCalls += 1
          return initializeCalls === 1
            ? Effect.fail(
                new KeymaxxerError({
                  operation: "initialize",
                  message: "failed",
                }),
              )
            : Effect.void
        }),
    })
    const fetchSidecar = createKeymaxxerSidecarFetch(service)
    const request = () =>
      fetchSidecar(
        new Request("http://127.0.0.1/initialize", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        }),
      )

    expect((await request()).status).toBe(500)
    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(200)
    expect(initializeCalls).toBe(2)
  })

  test("validates all routes and rejects unknown request fields", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createKeymaxxerSidecarFetch(
        fakeService({
          hasSecret: (name) => Effect.succeed(name === "PRESENT_SECRET"),
        }),
      ),
    })

    try {
      expect(
        await (
          await post(new URL("/has-secret", server.url), {
            name: "PRESENT_SECRET",
          })
        ).json(),
      ).toEqual({ hasSecret: true })
      expect(
        (
          await post(new URL("/has-secret", server.url), {
            name: "PRESENT_SECRET",
            extra: true,
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await post(new URL("/run-with-secrets", server.url), {
            command: "pwd",
            cwd: "relative",
            secrets: ["A_SECRET"],
            timeoutMs: 100,
          })
        ).status,
      ).toBe(400)
    } finally {
      await server.stop(true)
    }
  })

  test("blocks browser-originated and non-JSON operation requests", async () => {
    let runCalls = 0
    const fetchSidecar = createKeymaxxerSidecarFetch(
      fakeService({
        runWithSecrets: () =>
          Effect.sync(() => {
            runCalls += 1
            return { exitCode: 0, stdout: "", stderr: "" }
          }),
      }),
    )
    const body = JSON.stringify({
      command: "pwd",
      cwd: "/tmp",
      secrets: ["A_SECRET"],
      timeoutMs: 100,
    })

    const browserResponse = await fetchSidecar(
      new Request("http://127.0.0.1/run-with-secrets", {
        method: "POST",
        body,
        headers: {
          "content-type": "text/plain",
          origin: "https://malicious.example",
        },
      }),
    )
    const nonJsonResponse = await fetchSidecar(
      new Request("http://127.0.0.1/run-with-secrets", {
        method: "POST",
        body,
        headers: { "content-type": "text/plain" },
      }),
    )

    expect(browserResponse.status).toBe(403)
    expect(nonJsonResponse.status).toBe(415)
    expect(runCalls).toBe(0)
  })
})

describe("sidecar-backed Keymaxxer layer", () => {
  test("exposes all operations over loopback HTTP", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createKeymaxxerSidecarFetch(
        fakeService({
          hasSecret: (name) => Effect.succeed(name === "PRESENT_SECRET"),
          addSecret: (input) => Effect.succeed(input.name === "NEW_SECRET"),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 4, stdout: "out", stderr: "err" }),
        }),
      ),
    })

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keymaxxer = yield* KeymaxxerService
          yield* keymaxxer.initialize()
          const present = yield* keymaxxer.hasSecret("PRESENT_SECRET")
          const added = yield* keymaxxer.addSecret({ name: "NEW_SECRET" })
          const run = yield* keymaxxer.runWithSecrets({
            command: "false",
            cwd: "/tmp",
            secrets: ["PRESENT_SECRET"],
            timeoutMs: 100,
          })
          return { present, added, run }
        }).pipe(Effect.provide(sidecarKeymaxxerLayer(server.url.toString()))),
      )

      expect(result).toEqual({
        present: true,
        added: true,
        run: { exitCode: 4, stdout: "out", stderr: "err" },
      })
    } finally {
      await server.stop(true)
    }
  })

  test("rejects remote and ambiguous URLs", async () => {
    for (const url of [
      "https://127.0.0.1:5032",
      "http://localhost:5032",
      "http://127.0.0.1:5032/path",
    ]) {
      const exit = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function* () {
            yield* KeymaxxerService
          }).pipe(Effect.provide(sidecarKeymaxxerLayer(url))),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }
  })

  test("retries initial connection failures before initialization", async () => {
    let calls = 0
    const fetchImplementation: typeof fetch = async (input) => {
      calls += 1
      if (calls < 3) throw new TypeError("connection refused")
      const path = new URL(input.toString()).pathname
      return Response.json(
        path === "/health"
          ? { status: "ok", protocolVersion: 1 }
          : { initialized: true },
      )
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize()
      }).pipe(
        Effect.provide(
          sidecarKeymaxxerLayer("http://127.0.0.1:5032", {
            fetch: fetchImplementation,
            retryDelayMs: 1,
            startupTimeoutMs: 100,
          }),
        ),
      ),
    )
    expect(calls).toBe(4)
  })

  test("does not retry after receiving an incompatible health response", async () => {
    let calls = 0
    const fetchImplementation: typeof fetch = async () => {
      calls += 1
      return Response.json({ status: "ok", protocolVersion: 2 })
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const keymaxxer = yield* KeymaxxerService
          yield* keymaxxer.initialize()
        }).pipe(
          Effect.provide(
            sidecarKeymaxxerLayer("http://127.0.0.1:5032", {
              fetch: fetchImplementation,
              retryDelayMs: 1,
              startupTimeoutMs: 100,
            }),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toBe(1)
  })

  test("times out a health request that never responds", async () => {
    const fetchImplementation: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        )
      })
    const startedAt = Date.now()
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const keymaxxer = yield* KeymaxxerService
          yield* keymaxxer.initialize()
        }).pipe(
          Effect.provide(
            sidecarKeymaxxerLayer("http://127.0.0.1:5032", {
              fetch: fetchImplementation,
              retryDelayMs: 1,
              startupTimeoutMs: 20,
            }),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  test("rejects response fields outside the shared schema", async () => {
    const fetchImplementation: typeof fetch = async () =>
      Response.json({ hasSecret: true, extra: true })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(keymaxxer.hasSecret("A_SECRET"))
      }).pipe(
        Effect.provide(
          sidecarKeymaxxerLayer("http://127.0.0.1:5032", {
            fetch: fetchImplementation,
          }),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("rejects responses containing raw secret fields", async () => {
    const fetchImplementation: typeof fetch = async () =>
      Response.json({ value: "raw-secret" })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        return yield* Effect.exit(keymaxxer.hasSecret("A_SECRET"))
      }).pipe(
        Effect.provide(
          sidecarKeymaxxerLayer("http://127.0.0.1:5032", {
            fetch: fetchImplementation,
          }),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
  })
})
