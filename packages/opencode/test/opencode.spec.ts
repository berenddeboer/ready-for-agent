import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  type OnSessionId,
  Opencode,
  OpencodeExitError,
  OpencodeIncompleteOutputError,
  OpencodeTimeoutError,
  parseVerboseModelsOutput,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-effect-test-"))
  const path = join(directory, "opencode")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const start = (
  binary: string,
  timeout: string,
  onSessionId?: OnSessionId,
  prompt = "test",
) =>
  Effect.gen(function* () {
    const opencode = yield* Opencode
    return yield* opencode.start({
      cwd: process.cwd(),
      prompt,
      model: "test/model",
      variant: "test",
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(
    Effect.provide(
      Opencode.layer({
        binary,
        keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
      }).pipe(Layer.provide(BunServices.layer)),
    ),
  )

describe("Opencode Effect service", () => {
  it("collects structured output from a scoped child process", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_test"}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"first"}}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"second"}}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(start(binary, "2 seconds")),
        ).resolves.toEqual({
          sessionId: "ses_test",
          assistantText: "first\nsecond",
        })
      },
    )
  })

  it("sends multi-line prompts through stdin without changing their structure", async () => {
    const prompt = "first\nsecond"
    await withExecutable(
      [
        "input=$(cat)",
        "expected=$(printf 'first\\nsecond')",
        '[ "$input" = "$expected" ] || exit 9',
        `printf '%s\n' '{"type":"step_start","sessionID":"ses_stdin"}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(start(binary, "2 seconds", undefined, prompt)),
        ).resolves.toEqual({
          sessionId: "ses_stdin",
          assistantText: "",
        })
      },
    )
  })

  it("returns a typed exit error with the observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_failed"}'`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          start(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          new OpencodeExitError({
            exitCode: 7,
            cwd: process.cwd(),
            sessionId: "ses_failed",
          }),
        )
      },
    )
  })

  it("retains an observed session in the typed timeout error", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_timeout"}'`,
        "sleep 10",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          start(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toEqual(
          new OpencodeTimeoutError({
            cwd: process.cwd(),
            timeoutMs: 200,
            sessionId: "ses_timeout",
          }),
        )
      },
    )
  })

  it("notifies onSessionId with the first streamed sessionID before process exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_early"}'`,
        "sleep 0.4",
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"done"}}'`,
      ].join("\n"),
      async (binary) => {
        const observed = await Effect.runPromise(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<string>()
            const fiber = yield* Effect.forkChild(
              start(binary, "5 seconds", (sessionId) =>
                Deferred.succeed(deferred, sessionId).pipe(Effect.asVoid),
              ),
            )
            const earlySessionId = yield* Deferred.await(deferred)
            const stillRunning = fiber.pollUnsafe() === undefined
            const result = yield* Fiber.await(fiber)
            return { earlySessionId, stillRunning, result }
          }),
        )

        expect(observed.earlySessionId).toBe("ses_early")
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe("ses_early")
        }
      },
    )
  })

  it("does not fail the run when onSessionId fails", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_observer_fail"}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"ok"}}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            start(binary, "2 seconds", () =>
              Effect.fail(new Error("observer boom") as never),
            ),
          ),
        ).resolves.toEqual({
          sessionId: "ses_observer_fail",
          assistantText: "ok",
        })
      },
    )
  })

  it("lists models with variants from verbose OpenCode output", async () => {
    await withExecutable(
      [
        'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
        `  printf '%s\\n' 'xai/grok-4.5'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {'`,
        `  printf '%s\\n' '    "low": {},'`,
        `  printf '%s\\n' '    "medium": {},'`,
        `  printf '%s\\n' '    "high": {}'`,
        `  printf '%s\\n' '  }'`,
        `  printf '%s\\n' '}'`,
        `  printf '%s\\n' 'xai/empty-variants'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {}'`,
        `  printf '%s\\n' '}'`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const models = await Effect.runPromise(
          Effect.gen(function* () {
            const opencode = yield* Opencode
            return yield* opencode.listModels({
              cwd: process.cwd(),
              timeout: "2 seconds",
            })
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
              }).pipe(Layer.provide(BunServices.layer)),
            ),
          ),
        )

        expect(models).toEqual([
          {
            id: "xai/grok-4.5",
            variants: ["low", "medium", "high"],
          },
          {
            id: "xai/empty-variants",
            variants: [],
          },
        ])
      },
    )
  })

  it("captures a full multi-provider verbose catalog beyond 64KB", async () => {
    const padding = "x".repeat(1200)
    const entries: string[] = []
    for (let index = 0; index < 55; index += 1) {
      entries.push(
        [
          `opencode/model-${index}`,
          "{",
          `  "id": "model-${index}",`,
          `  "padding": "${padding}",`,
          '  "variants": {',
          '    "low": {},',
          '    "medium": {},',
          '    "high": {}',
          "  }",
          "}",
        ].join("\n"),
      )
    }
    entries.push(
      [
        "xai/grok-4.5",
        "{",
        '  "id": "grok-4.5",',
        '  "variants": {',
        '    "low": {},',
        '    "medium": {},',
        '    "high": {}',
        "  }",
        "}",
      ].join("\n"),
    )
    const fullStdout = `${entries.join("\n")}\n`
    expect(Buffer.byteLength(fullStdout, "utf8")).toBeGreaterThan(64 * 1024)
    const expected = parseVerboseModelsOutput(fullStdout)
    expect(expected.length).toBe(56)
    expect(expected.at(-1)).toEqual({
      id: "xai/grok-4.5",
      variants: ["low", "medium", "high"],
    })

    const directory = await mkdtemp(join(tmpdir(), "opencode-effect-test-"))
    const fixturePath = join(directory, "models-verbose.txt")
    const binaryPath = join(directory, "opencode")
    try {
      await writeFile(fixturePath, fullStdout)
      await writeFile(
        binaryPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
          `  cat "${fixturePath}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      const models = await Effect.runPromise(
        Effect.gen(function* () {
          const opencode = yield* Opencode
          return yield* opencode.listModels({
            cwd: process.cwd(),
            timeout: "5 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary: binaryPath,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )

      expect(models).toEqual(expected)
      expect(models.find((model) => model.id === "xai/grok-4.5")).toEqual({
        id: "xai/grok-4.5",
        variants: ["low", "medium", "high"],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("fails when verbose models stdout is truncated mid-object", async () => {
    await withExecutable(
      [
        'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
        `  printf '%s\\n' 'opencode/kimi-k2.5'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {'`,
        `  printf '%s\\n' '    "low": {}'`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const opencode = yield* Opencode
            return yield* opencode.listModels({
              cwd: process.cwd(),
              timeout: "2 seconds",
            })
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
              }).pipe(Layer.provide(BunServices.layer)),
            ),
            Effect.flip,
          ),
        )

        expect(error).toBeInstanceOf(OpencodeIncompleteOutputError)
        if (error instanceof OpencodeIncompleteOutputError) {
          expect(error.cwd).toBe(process.cwd())
          expect(error.byteLength).toBeGreaterThan(0)
        }
      },
    )
  })
})
