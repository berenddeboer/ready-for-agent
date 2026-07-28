import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendMalformedOutputError,
} from "@ready-for-agent/agent-backend"
import {
  CODEX_STATIC_CATALOG,
  CODEX_UNAUTHENTICATED_MESSAGE,
  Codex,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-effect-test-"))
  const path = join(directory, "codex")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const provide = (binary: string) =>
  Codex.layer({ binary }).pipe(Layer.provide(BunServices.layer))

const inspect = (binary: string, timeout = "2 seconds") =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.inspect({
      cwd: process.cwd(),
      timeout,
    })
  }).pipe(Effect.provide(provide(binary)))

describe("Codex AgentBackend adapter (readiness inspection)", () => {
  it("inspects authenticated CLI via stderr status (real CLI shape)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        // Real codex prints status with eprintln! (stderr only, empty stdout).
        "echo 'Logged in using ChatGPT' 1>&2",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend).toEqual({ id: "codex", label: "Codex Build" })
        expect(result.models).toEqual(
          CODEX_STATIC_CATALOG.map((model) => ({
            id: model.id,
            thinkingLevels: [...model.thinkingLevels],
          })),
        )
      },
    )
  })

  it("inspects when API key login is stored (stderr status)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'Logged in using an API key - sk-test' 1>&2",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend.id).toBe("codex")
        expect(result.models.length).toBeGreaterThan(0)
      },
    )
  })

  it("fails inspect with actionable config error when unauthenticated (stderr)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'Not logged in' 1>&2",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("codex login")
          expect(error.message).toContain("OPENAI_API_KEY")
        }
      },
    )
  })

  it("maps non-zero login status without auth markers to config error with probe text", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'internal crash' 1>&2",
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toContain("exit 7")
          expect(error.message).toContain("internal crash")
          expect(error.message).not.toBe(CODEX_UNAUTHENTICATED_MESSAGE)
        }
      },
    )
  })

  it("fails inspect when login status output is malformed", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'something unexpected without auth markers' 1>&2",
        "exit 0",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails inspect when the binary is missing", async () => {
    const missing = join(tmpdir(), `codex-missing-${Date.now()}`)
    const error = await Effect.runPromise(inspect(missing).pipe(Effect.flip))
    // Spawn failure surfaces as PlatformError (NotFound) through the shared runner.
    expect(error).toBeDefined()
    expect(error).not.toBeInstanceOf(AgentBackendConfigError)
    expect((error as { _tag?: string })._tag).toBe("PlatformError")
    const reason = (error as { reason?: { _tag?: string } }).reason
    expect(reason?._tag).toBe("NotFound")
  })

  it("startTurn and continueTurn fail until Agent Turns ship", async () => {
    await withExecutable("exit 0", async (binary) => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          const start = yield* backend
            .startTurn({
              cwd: process.cwd(),
              prompt: "x",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "1 second",
            })
            .pipe(Effect.flip)
          const cont = yield* backend
            .continueTurn({
              cwd: process.cwd(),
              sessionId: "thread-1",
              prompt: "y",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "1 second",
            })
            .pipe(Effect.flip)
          return { start, cont }
        }).pipe(Effect.provide(provide(binary))),
      )

      expect(outcome.start).toBeInstanceOf(AgentBackendConfigError)
      expect(outcome.cont).toBeInstanceOf(AgentBackendConfigError)
      if (outcome.start instanceof AgentBackendConfigError) {
        expect(outcome.start.message).toContain("not available yet")
        expect(outcome.start.message).toContain("startTurn")
      }
      if (outcome.cont instanceof AgentBackendConfigError) {
        expect(outcome.cont.message).toContain("continueTurn")
      }
    })
  })
})
