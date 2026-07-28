import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
  runCliCapture,
  runCliTurn,
  sanitizeInheritedEnvironment,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

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

describe("sanitizeInheritedEnvironment", () => {
  it("strips GitHub token variables and keeps others", () => {
    expect(
      sanitizeInheritedEnvironment({
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITHUB_TOKEN_WORK: "secret3",
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

  it("maps missing session id after success", async () => {
    await withExecutable(`printf '%s\\n' '{"text":"only"}'`, async (binary) => {
      const error = await Effect.runPromise(
        withSpawner((spawner) =>
          runCliTurn({
            spawner,
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

  it("returns cleanly when the CLI exits on its own", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"sessionID":"ses_clean","text":"ok"}'`].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          withSpawner((spawner) =>
            runCliTurn({
              spawner,
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

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
