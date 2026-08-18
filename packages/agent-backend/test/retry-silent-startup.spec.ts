import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Ref } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { runCliTurn } from "../src/lib/cli-runner.js"
import { sanitizeInheritedEnvironment } from "../src/lib/environment.js"
import {
  AgentBackendExitError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
  formatAgentBackendStartupTimeoutMessage,
} from "../src/lib/errors.js"
import { retrySilentKnownSessionStartup } from "../src/lib/retry-silent-startup.js"
import { describe, expect, it } from "bun:test"

const TEST_BACKEND = { id: "claude" as const, label: "Claude Code" }

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "agent-backend-retry-"))
  const path = join(directory, "fake-cli")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const withSpawner = <A, E>(
  use: (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* use(spawner)
  }).pipe(Effect.provide(BunServices.layer))

const parseSimpleLine = (line: string) => {
  try {
    const parsed = JSON.parse(line) as {
      sessionID?: string
      text?: string
    }
    return {
      ...(typeof parsed.sessionID === "string"
        ? { sessionId: parsed.sessionID }
        : {}),
      ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
    }
  } catch {
    return {}
  }
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("retrySilentKnownSessionStartup", () => {
  it("returns the second attempt when the first is a silent startup timeout", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const result = await Effect.runPromise(
      retrySilentKnownSessionStartup(
        () =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(calls, (value) => value + 1)
            if (n === 1) {
              return yield* new AgentBackendStartupTimeoutError({
                cwd: "/tmp",
                startupTimeoutMs: 200,
                sessionId: "ses_retry",
              })
            }
            return { sessionId: "ses_retry", assistantText: "recovered" }
          }),
        {
          sessionId: "ses_retry",
          model: "test/model",
          observerLabel: "OpenCode",
        },
      ),
    )
    expect(result).toEqual({
      sessionId: "ses_retry",
      assistantText: "recovered",
    })
    expect(await Effect.runPromise(Ref.get(calls))).toBe(2)
  })

  it("does not retry a full-turn timeout, nonzero exit, or malformed-style failure", async () => {
    const timeoutCalls = await Effect.runPromise(Ref.make(0))
    const timeoutError = await Effect.runPromise(
      retrySilentKnownSessionStartup(
        () =>
          Effect.gen(function* () {
            yield* Ref.update(timeoutCalls, (value) => value + 1)
            return yield* new AgentBackendTimeoutError({
              cwd: "/tmp",
              timeoutMs: 1_000,
              sessionId: "ses_retry",
            })
          }),
        { sessionId: "ses_retry", model: "test/model" },
      ).pipe(Effect.flip),
    )
    expect(timeoutError).toBeInstanceOf(AgentBackendTimeoutError)
    expect(await Effect.runPromise(Ref.get(timeoutCalls))).toBe(1)

    const exitCalls = await Effect.runPromise(Ref.make(0))
    const exitError = await Effect.runPromise(
      retrySilentKnownSessionStartup(
        () =>
          Effect.gen(function* () {
            yield* Ref.update(exitCalls, (value) => value + 1)
            return yield* AgentBackendExitError.new({
              exitCode: 7,
              cwd: "/tmp",
              sessionId: "ses_retry",
              message: "OpenCode failed with exit code 7",
            })
          }),
        { sessionId: "ses_retry", model: "test/model" },
      ).pipe(Effect.flip),
    )
    expect(exitError).toBeInstanceOf(AgentBackendExitError)
    expect(await Effect.runPromise(Ref.get(exitCalls))).toBe(1)
  })

  it("fails after two silent attempts with session, model, window, and both attempt numbers", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const error = await Effect.runPromise(
      retrySilentKnownSessionStartup(
        () =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (value) => value + 1)
            return yield* new AgentBackendStartupTimeoutError({
              cwd: "/work",
              startupTimeoutMs: 200,
              sessionId: "ses_retry",
            })
          }),
        {
          sessionId: "ses_retry",
          model: "opencode/deepseek",
          observerLabel: "OpenCode",
        },
      ).pipe(Effect.flip),
    )
    expect(error).toEqual(
      new AgentBackendStartupTimeoutError({
        cwd: "/work",
        startupTimeoutMs: 200,
        sessionId: "ses_retry",
        model: "opencode/deepseek",
        attemptCount: 2,
      }),
    )
    expect(await Effect.runPromise(Ref.get(calls))).toBe(2)
    expect(
      formatAgentBackendStartupTimeoutMessage({
        backendLabel: "OpenCode",
        action: "while applying Review Findings",
        cause: error,
        phase: "review_applying_findings",
      }),
    ).toBe(
      "OpenCode failed while applying Review Findings: no output within the startup window (200ms); session ses_retry; model opencode/deepseek; phase review_applying_findings; attempts 1 and 2",
    )
  })

  it("replays the same CLI turn after reaping the first silent process tree", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-backend-retry-tree-"))
    const counterFile = join(markerDir, "count")
    const firstPidFile = join(markerDir, "first.pid")
    const firstDeadFile = join(markerDir, "first.dead")
    try {
      await writeFile(counterFile, "0")
      await withExecutable(
        [
          `count=$(($(cat "${counterFile}") + 1))`,
          `echo "$count" > "${counterFile}"`,
          `if [ "$count" -eq 1 ]; then`,
          `  setsid sh -c 'echo $$ > "${firstPidFile}"; sleep 100' &`,
          `  while [ ! -s "${firstPidFile}" ]; do sleep 0.01; done`,
          `  sleep 100`,
          `fi`,
          `if [ -s "${firstPidFile}" ]; then`,
          `  first=$(cat "${firstPidFile}")`,
          `  if kill -0 "$first" 2>/dev/null; then exit 11; fi`,
          `  echo dead > "${firstDeadFile}"`,
          `fi`,
          `printf '%s\\n' '{"sessionID":"ses_retry","text":"recovered"}'`,
        ].join("\n"),
        async (binary) => {
          const result = await Effect.runPromise(
            withSpawner((spawner) =>
              retrySilentKnownSessionStartup(
                () =>
                  runCliTurn({
                    spawner,
                    backend: TEST_BACKEND,
                    binary,
                    args: [],
                    cwd: process.cwd(),
                    env: sanitizeInheritedEnvironment(),
                    timeout: Duration.seconds(5),
                    startupTimeout: Duration.millis(250),
                    forceKillAfter: Duration.millis(100),
                    knownSessionId: "ses_retry",
                    parseLine: parseSimpleLine,
                  }),
                {
                  sessionId: "ses_retry",
                  model: "test/model",
                  observerLabel: "OpenCode",
                },
              ),
            ),
          )
          expect(result).toEqual({
            sessionId: "ses_retry",
            assistantText: "recovered",
          })
          expect((await Bun.file(counterFile).text()).trim()).toBe("2")
          expect((await Bun.file(firstDeadFile).text()).trim()).toBe("dead")
          const firstPid = Number((await Bun.file(firstPidFile).text()).trim())
          expect(Number.isFinite(firstPid) && firstPid > 0).toBe(true)
          expect(isPidAlive(firstPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("fails two silent attempts within a bounded duration", async () => {
    await withExecutable("sleep 100", async (binary) => {
      const startedAt = Date.now()
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          retrySilentKnownSessionStartup(
            () =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.seconds(30),
                startupTimeout: Duration.millis(200),
                forceKillAfter: Duration.millis(100),
                knownSessionId: "ses_retry",
                parseLine: parseSimpleLine,
              }),
            {
              sessionId: "ses_retry",
              model: "test/model",
              observerLabel: "OpenCode",
            },
          ).pipe(Effect.flip),
        ),
      )
      const elapsed = Date.now() - startedAt
      expect(error).toEqual(
        new AgentBackendStartupTimeoutError({
          cwd: process.cwd(),
          startupTimeoutMs: 200,
          sessionId: "ses_retry",
          model: "test/model",
          attemptCount: 2,
        }),
      )
      expect(elapsed).toBeLessThan(5_000)
    })
  })
})
