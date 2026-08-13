import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { systemError } from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AgentBackendExitError,
  AgentBackendNotInstalledError,
  AgentBackendSessionIdMissingError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
  runCliCapture,
  runCliTurn,
  sanitizeInheritedEnvironment,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TEST_BACKEND = { id: "claude" as const, label: "Claude Code" }

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "agent-backend-cli-"))
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
      errorClassification?:
        | "retryable_provider_error"
        | "length_limit_truncation"
    }
    return {
      ...(typeof parsed.sessionID === "string"
        ? { sessionId: parsed.sessionID }
        : {}),
      ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
      ...(parsed.errorClassification !== undefined
        ? { errorClassification: parsed.errorClassification }
        : {}),
    }
  } catch {
    return {}
  }
}

describe("sanitizeInheritedEnvironment", () => {
  it("strips Forge token variables and keeps others", () => {
    expect(
      sanitizeInheritedEnvironment({
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITHUB_TOKEN_WORK: "secret3",
        GITLAB_TOKEN: "secret4",
        GITLAB_TOKEN_WORK: "secret5",
        OPENAI_API_KEY: "keep",
        EMPTY: undefined,
      }),
    ).toEqual({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "keep",
    })
  })
})

describe("runCliCapture", () => {
  it("uses supplied cwd and environment", async () => {
    await withExecutable(
      [
        'printf "cwd=%s\\n" "$(pwd)"',
        'printf "marker=%s\\n" "$CLI_MARKER"',
        'printf "gh=%s\\n" "$' + "{GH_TOKEN-}" + '"',
      ].join("\n"),
      async (binary) => {
        const directory = await mkdtemp(join(tmpdir(), "agent-backend-cwd-"))
        try {
          const result = await Effect.runPromise(
            withSpawner((spawner) =>
              runCliCapture({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: directory,
                env: {
                  ...sanitizeInheritedEnvironment(),
                  CLI_MARKER: "present",
                },
                timeout: Duration.seconds(2),
              }),
            ),
          )
          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain(`cwd=${directory}`)
          expect(result.stdout).toContain("marker=present")
          expect(result.stdout).toContain("gh=\n")
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    )
  })

  it("maps nonzero exit to AgentBackendExitError", async () => {
    await withExecutable("exit 9", async (binary) => {
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          runCliCapture({
            spawner,
            backend: TEST_BACKEND,
            binary,
            args: [],
            cwd: process.cwd(),
            env: sanitizeInheritedEnvironment(),
            timeout: Duration.seconds(2),
          }).pipe(Effect.flip),
        ),
      )
      expect(error).toEqual(
        new AgentBackendExitError({
          exitCode: 9,
          cwd: process.cwd(),
        }),
      )
    })
  })

  it("returns stdout when allowNonZeroExit is set", async () => {
    await withExecutable(
      ["echo 'Not logged in'", "exit 1"].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliCapture({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              allowNonZeroExit: true,
            }),
          ),
        )
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain("Not logged in")
        expect(result.stderr).toBe("")
      },
    )
  })

  it("captures stderr when captureStderr is set", async () => {
    await withExecutable(
      ["echo 'Logged in using ChatGPT' 1>&2", "exit 0"].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliCapture({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              captureStderr: true,
            }),
          ),
        )
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("Logged in using ChatGPT")
      },
    )
  })
})

describe("runCliTurn", () => {
  it("collects ordered assistant text and session id", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"sessionID":"ses_a","text":"first"}'`,
        `printf '%s\\n' '{"text":"second"}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.seconds(2),
                parseLine: parseSimpleLine,
              }),
            ),
          ),
        ).resolves.toEqual({
          sessionId: "ses_a",
          assistantText: "first\nsecond",
        })
      },
    )
  })

  it("notifies onSessionId before process exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"sessionID":"ses_early"}'`,
        "sleep 0.4",
        `printf '%s\\n' '{"text":"done"}'`,
      ].join("\n"),
      async (binary) => {
        const observed = await Effect.runPromise(
          withSpawner((spawner) =>
            Effect.gen(function* () {
              const deferred = yield* Deferred.make<string>()
              const fiber = yield* Effect.forkChild(
                runCliTurn({
                  spawner,
                  backend: TEST_BACKEND,
                  binary,
                  args: [],
                  cwd: process.cwd(),
                  env: sanitizeInheritedEnvironment(),
                  timeout: Duration.seconds(5),
                  parseLine: parseSimpleLine,
                  onSessionId: (sessionId) =>
                    Deferred.succeed(deferred, sessionId).pipe(Effect.asVoid),
                }),
              )
              const earlySessionId = yield* Deferred.await(deferred)
              const stillRunning = fiber.pollUnsafe() === undefined
              const result = yield* Fiber.await(fiber)
              return { earlySessionId, stillRunning, result }
            }),
          ),
        )
        expect(observed.earlySessionId).toBe("ses_early")
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
      },
    )
  })

  it("carries an observed error classification on a non-zero exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"sessionID":"ses_retry","errorClassification":"retryable_provider_error"}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              parseLine: parseSimpleLine,
            }).pipe(Effect.flip),
          ),
        )
        expect(error).toEqual(
          new AgentBackendExitError({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_retry",
            classification: "retryable_provider_error",
          }),
        )
      },
    )
  })

  it("omits classification on a non-zero exit with no observed error event", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"sessionID":"ses_plain"}'`, "exit 1"].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              parseLine: parseSimpleLine,
            }).pipe(Effect.flip),
          ),
        )
        expect(error).toEqual(
          new AgentBackendExitError({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_plain",
          }),
        )
      },
    )
  })

  it("maps missing session id after success", async () => {
    await withExecutable(`printf '%s\\n' '{"text":"only"}'`, async (binary) => {
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          runCliTurn({
            spawner,
            backend: TEST_BACKEND,
            binary,
            args: [],
            cwd: process.cwd(),
            env: sanitizeInheritedEnvironment(),
            timeout: Duration.seconds(2),
            parseLine: parseSimpleLine,
          }).pipe(Effect.flip),
        ),
      )
      expect(error).toEqual(
        new AgentBackendSessionIdMissingError({ cwd: process.cwd() }),
      )
    })
  })

  it("retains observed session on timeout", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"sessionID":"ses_timeout"}'`, "sleep 10"].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.millis(200),
              parseLine: parseSimpleLine,
              forceKillAfter: Duration.millis(100),
            }).pipe(Effect.flip),
          ),
        )
        expect(error).toEqual(
          new AgentBackendTimeoutError({
            cwd: process.cwd(),
            timeoutMs: 200,
            sessionId: "ses_timeout",
          }),
        )
      },
    )
  })

  it("terminates the process tree on timeout", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-backend-tree-"))
    const childAlive = join(markerDir, "child-alive")
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withExecutable(
        [
          // Record grandchild pid before the session line so the assert is hard.
          `( while true; do touch "${childAlive}"; sleep 0.05; done ) &`,
          `echo $! > "${grandPidFile}"`,
          `while [ ! -s "${grandPidFile}" ]; do sleep 0.01; done`,
          `printf '%s\\n' '{"sessionID":"ses_tree"}'`,
          "wait",
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.millis(300),
                parseLine: parseSimpleLine,
                forceKillAfter: Duration.millis(100),
              }).pipe(Effect.flip),
            ),
          )
          await Bun.sleep(400)
          const stillTouched = await Bun.file(childAlive)
            .stat()
            .then((s) => Date.now() - s.mtime.getTime() < 200)
            .catch(() => false)
          expect(stillTouched).toBe(false)

          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("terminates setsid grandchildren on timeout", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-backend-setsid-"))
    const childAlive = join(markerDir, "child-alive")
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withExecutable(
        [
          // Leave the process group (like some agent CLIs) so group-only kill
          // is insufficient; tree kill via PPID must still reap the child.
          `setsid sh -c 'echo $$ > "${grandPidFile}"; while true; do touch "${childAlive}"; sleep 0.05; done' &`,
          `while [ ! -s "${grandPidFile}" ]; do sleep 0.01; done`,
          `printf '%s\\n' '{"sessionID":"ses_setsid"}'`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.millis(400),
                parseLine: parseSimpleLine,
                forceKillAfter: Duration.millis(100),
              }).pipe(Effect.flip),
            ),
          )
          await Bun.sleep(300)
          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
          const stillTouched = await Bun.file(childAlive)
            .stat()
            .then((s) => Date.now() - s.mtime.getTime() < 200)
            .catch(() => false)
          expect(stillTouched).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("terminates the process tree on finalizeText", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-backend-finalize-"))
    const childAlive = join(markerDir, "child-alive")
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withExecutable(
        [
          // Spawn the setsid grandchild first so it exists before finalize kills.
          `setsid sh -c 'echo $$ > "${grandPidFile}"; while true; do touch "${childAlive}"; sleep 0.05; done' &`,
          `while [ ! -s "${grandPidFile}" ]; do sleep 0.01; done`,
          `printf '%s\\n' '{"sessionID":"ses_fin","finalize":"done"}'`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          const result = await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.seconds(5),
                forceKillAfter: Duration.millis(100),
                parseLine: (line) => {
                  try {
                    const parsed = JSON.parse(line) as {
                      sessionID?: string
                      finalize?: string
                    }
                    if (
                      typeof parsed.sessionID === "string" &&
                      typeof parsed.finalize === "string"
                    ) {
                      return {
                        sessionId: parsed.sessionID,
                        finalizeText: parsed.finalize,
                      }
                    }
                    return parseSimpleLine(line)
                  } catch {
                    return {}
                  }
                },
              }),
            ),
          )
          expect(result).toEqual({
            sessionId: "ses_fin",
            assistantText: "done",
          })
          await Bun.sleep(300)
          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("fails within the startup window when the CLI emits nothing", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-backend-startup-"))
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withExecutable(
        [
          // Silent hang after spawning a descendant: the failure mode the
          // startup window exists for (bad auth, broken config, crash).
          `setsid sh -c 'echo $$ > "${grandPidFile}"; sleep 100' &`,
          `while [ ! -s "${grandPidFile}" ]; do sleep 0.01; done`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          const startedAt = Date.now()
          const error = await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.seconds(30),
                startupTimeout: Duration.millis(300),
                forceKillAfter: Duration.millis(100),
                knownSessionId: "ses_startup",
                parseLine: parseSimpleLine,
              }).pipe(Effect.flip),
            ),
          )
          const elapsed = Date.now() - startedAt

          expect(error).toEqual(
            new AgentBackendStartupTimeoutError({
              cwd: process.cwd(),
              startupTimeoutMs: 300,
              sessionId: "ses_startup",
            }),
          )
          // Startup window, not the 30 second turn timeout.
          expect(elapsed).toBeLessThan(5_000)

          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("omits the session id when a silent CLI has no known session", async () => {
    await withExecutable("sleep 100", async (binary) => {
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
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
            parseLine: parseSimpleLine,
          }).pipe(Effect.flip),
        ),
      )
      expect(error).toEqual(
        new AgentBackendStartupTimeoutError({
          cwd: process.cwd(),
          startupTimeoutMs: 200,
        }),
      )
    })
  })

  it("reports the exit code when a silent CLI exits before the startup window", async () => {
    await withExecutable("exit 7", async (binary) => {
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          runCliTurn({
            spawner,
            backend: TEST_BACKEND,
            binary,
            args: [],
            cwd: process.cwd(),
            env: sanitizeInheritedEnvironment(),
            timeout: Duration.seconds(5),
            startupTimeout: Duration.seconds(5),
            parseLine: parseSimpleLine,
          }).pipe(Effect.flip),
        ),
      )
      expect(error).toEqual(
        new AgentBackendExitError({ exitCode: 7, cwd: process.cwd() }),
      )
    })
  })

  it("disarms the startup window once the CLI emits output", async () => {
    await withExecutable(
      [
        // Output arrives inside the startup window, then a long silence like a
        // legitimate build or test-suite tool call. Only the turn timeout applies.
        `printf '%s\\n' '{"sessionID":"ses_quiet"}'`,
        "sleep 100",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.millis(600),
              startupTimeout: Duration.millis(200),
              forceKillAfter: Duration.millis(100),
              parseLine: parseSimpleLine,
            }).pipe(Effect.flip),
          ),
        )
        expect(error).toEqual(
          new AgentBackendTimeoutError({
            cwd: process.cwd(),
            timeoutMs: 600,
            sessionId: "ses_quiet",
          }),
        )
      },
    )
  })

  it("completes a slow turn whose first output beats the startup window", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"sessionID":"ses_slow"}'`,
        "sleep 0.5",
        `printf '%s\\n' '{"text":"late"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(5),
              startupTimeout: Duration.millis(250),
              parseLine: parseSimpleLine,
            }),
          ),
        )
        expect(result).toEqual({
          sessionId: "ses_slow",
          assistantText: "late",
        })
      },
    )
  })

  it("disarms the startup window when observeStartup succeeds before first stdout", async () => {
    // OpenCode-like: outer stream stays silent past the startup window while a
    // backend side channel reports the turn has begun (task subagent active).
    await withExecutable(
      [
        "sleep 0.45",
        `printf '%s\\n' '{"sessionID":"ses_side","text":"from-child"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(5),
              startupTimeout: Duration.millis(200),
              forceKillAfter: Duration.millis(100),
              parseLine: parseSimpleLine,
              observeStartup: Effect.sleep(Duration.millis(50)),
            }),
          ),
        )
        expect(result).toEqual({
          sessionId: "ses_side",
          assistantText: "from-child",
        })
      },
    )
  })

  it("still fails within the startup window when observeStartup never completes", async () => {
    await withExecutable("sleep 100", async (binary) => {
      const startedAt = Date.now()
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
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
            parseLine: parseSimpleLine,
            // Never reports activity: silent CLI must still fail fast.
            observeStartup: Effect.never,
          }).pipe(Effect.flip),
        ),
      )
      const elapsed = Date.now() - startedAt
      expect(error).toEqual(
        new AgentBackendStartupTimeoutError({
          cwd: process.cwd(),
          startupTimeoutMs: 200,
        }),
      )
      expect(elapsed).toBeLessThan(5_000)
    })
  })

  it("ignores observeStartup failures and still uses stdout to disarm", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"sessionID":"ses_probe_fail","text":"ok"}'`].join(
        "\n",
      ),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              startupTimeout: Duration.millis(300),
              parseLine: parseSimpleLine,
              observeStartup: Effect.fail(new Error("probe broken")),
            }),
          ),
        )
        expect(result).toEqual({
          sessionId: "ses_probe_fail",
          assistantText: "ok",
        })
      },
    )
  })

  it("stops observeStartup once stdout disarms the startup window", async () => {
    let probeTicks = 0
    await withExecutable(
      [
        `printf '%s\\n' '{"sessionID":"ses_probe_stop","text":"ok"}'`,
        // Keep the turn alive so a leaked probe would keep ticking.
        "sleep 0.4",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(5),
              startupTimeout: Duration.seconds(5),
              forceKillAfter: Duration.millis(100),
              parseLine: parseSimpleLine,
              observeStartup: Effect.gen(function* () {
                for (;;) {
                  probeTicks += 1
                  yield* Effect.sleep(Duration.millis(50))
                }
              }),
            }),
          ),
        )
        expect(result).toEqual({
          sessionId: "ses_probe_stop",
          assistantText: "ok",
        })
        // Probe should be interrupted shortly after first stdout; a full-turn
        // leak over ~400ms would land many more 50ms ticks.
        expect(probeTicks).toBeLessThan(6)
      },
    )
  })

  it("returns cleanly when the CLI exits on its own", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"sessionID":"ses_clean","text":"ok"}'`].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
              backend: TEST_BACKEND,
              binary,
              args: [],
              cwd: process.cwd(),
              env: sanitizeInheritedEnvironment(),
              timeout: Duration.seconds(2),
              parseLine: parseSimpleLine,
            }),
          ),
        )
        expect(result).toEqual({
          sessionId: "ses_clean",
          assistantText: "ok",
        })
      },
    )
  })
})

const enoentPlatformError = systemError({
  _tag: "NotFound",
  module: "ChildProcess",
  method: "spawn",
  description: "ChildProcess.spawn (claude -p --output-format stream-json ...)",
  cause: Object.assign(new Error('Executable not found in $PATH: "claude"'), {
    code: "ENOENT",
  }),
})

const eaccesPlatformError = systemError({
  _tag: "PermissionDenied",
  module: "ChildProcess",
  method: "spawn",
  description: "ChildProcess.spawn (claude)",
  cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
})

const failingSpawner = (error: ReturnType<typeof systemError>) =>
  ChildProcessSpawner.make(() => Effect.fail(error))

describe("runCliCapture spawn not-found", () => {
  it("maps an ENOENT spawn failure to AgentBackendNotInstalledError", async () => {
    const error = await Effect.runPromise(
      runCliCapture({
        spawner: failingSpawner(enoentPlatformError),
        backend: TEST_BACKEND,
        binary: "claude",
        args: [],
        cwd: process.cwd(),
        env: sanitizeInheritedEnvironment(),
        timeout: Duration.seconds(2),
      }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AgentBackendNotInstalledError)
    if (error instanceof AgentBackendNotInstalledError) {
      expect(error.binary).toBe("claude")
      expect(error.backend).toEqual(TEST_BACKEND)
      expect(error.message).toContain(
        'Claude Code CLI "claude" was not found on the Harness PATH.',
      )
      expect(error.message).toContain("`command -v claude`")
      expect(error.message).toContain("restart the Harness")
    }
  })

  it("leaves a non-ENOENT spawn PlatformError unclassified", async () => {
    const error = await Effect.runPromise(
      runCliCapture({
        spawner: failingSpawner(eaccesPlatformError),
        backend: TEST_BACKEND,
        binary: "claude",
        args: [],
        cwd: process.cwd(),
        env: sanitizeInheritedEnvironment(),
        timeout: Duration.seconds(2),
      }).pipe(Effect.flip),
    )
    expect(error).not.toBeInstanceOf(AgentBackendNotInstalledError)
    expect((error as { _tag?: string })._tag).toBe("PlatformError")
  })

  it("leaves a missing cwd as PlatformError, not a missing CLI", async () => {
    await withExecutable("exit 0", async (binary) => {
      const missingCwd = join(
        tmpdir(),
        `agent-backend-missing-cwd-${Date.now()}`,
      )
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          runCliCapture({
            spawner,
            backend: TEST_BACKEND,
            binary,
            args: [],
            cwd: missingCwd,
            env: sanitizeInheritedEnvironment(),
            timeout: Duration.seconds(2),
          }).pipe(Effect.flip),
        ),
      )
      expect(error).not.toBeInstanceOf(AgentBackendNotInstalledError)
      expect((error as { _tag?: string })._tag).toBe("PlatformError")
    })
  })
})

describe("runCliTurn spawn not-found", () => {
  it("maps an ENOENT spawn failure to AgentBackendNotInstalledError", async () => {
    const error = await Effect.runPromise(
      runCliTurn({
        spawner: failingSpawner(enoentPlatformError),
        backend: TEST_BACKEND,
        binary: "claude",
        args: [],
        cwd: process.cwd(),
        env: sanitizeInheritedEnvironment(),
        timeout: Duration.seconds(2),
        parseLine: parseSimpleLine,
      }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AgentBackendNotInstalledError)
    if (error instanceof AgentBackendNotInstalledError) {
      expect(error.message).toContain(
        'Claude Code CLI "claude" was not found on the Harness PATH.',
      )
    }
  })
})

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
