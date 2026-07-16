import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  Opencode,
  OpencodeExitError,
  OpencodeTimeoutError,
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

const start = (binary: string, timeout: string) =>
  Effect.gen(function* () {
    const opencode = yield* Opencode
    return yield* opencode.start({
      cwd: process.cwd(),
      prompt: "test",
      model: "test/model",
      variant: "test",
      timeout,
    })
  }).pipe(
    Effect.provide(
      Opencode.layer({
        binary,
        keymaxxerMcpUrl: "http://127.0.0.1:5032/test/mcp",
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
})
