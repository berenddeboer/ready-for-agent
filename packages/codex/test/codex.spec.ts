import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendNotInstalledError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
  type OnSessionId,
  PROMPT_ARGV_BYTE_LIMIT,
} from "@ready-for-agent/agent-backend"
import {
  CODEX_APP_SERVER_DISCOVERY_FAILED_MESSAGE,
  CODEX_BUNDLED_CATALOG_EMPTY_MESSAGE,
  CODEX_BUNDLED_CATALOG_MALFORMED_MESSAGE,
  CODEX_MIN_CLI_VERSION,
  CODEX_UNAUTHENTICATED_MESSAGE,
  Codex,
  type CodexLayerOptions,
} from "../src/index.js"
import {
  DEFAULT_APP_SERVER_PAGES,
  DEFAULT_BUNDLED_MODELS,
  HIDDEN_DAYBREAK_MODEL,
  withExecutable,
  withFakeCodex,
} from "./fake-codex-cli.js"
import { describe, expect, it } from "bun:test"

const provide = (
  binary: string,
  options: Pick<CodexLayerOptions, "environment"> = {},
) =>
  Codex.layer({
    binary,
    ...options,
  }).pipe(Layer.provide(BunServices.layer))

const inspect = (
  binary: string,
  timeout = "2 seconds",
  options: Pick<CodexLayerOptions, "environment"> = {},
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.inspect({
      cwd: process.cwd(),
      timeout,
    })
  }).pipe(Effect.provide(provide(binary, options)))

const withCodexHome = async <A>(
  files: Readonly<Record<string, string>>,
  use: (env: {
    readonly CODEX_HOME: string
    readonly HOME: string
  }) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-inspect-home-"))
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content)
    }
    return await use({ CODEX_HOME: directory, HOME: directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const isolatedFirstPartyEnv = async <A>(
  use: (env: {
    readonly CODEX_HOME: string
    readonly HOME: string
  }) => Promise<A>,
): Promise<A> => withCodexHome({}, use)

const firstPartyDiscoverEnv = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  ...process.env,
  FAKE_MODEL_PAGES: JSON.stringify(DEFAULT_APP_SERVER_PAGES),
  FAKE_NOTIFY_BEFORE: "1",
  PYTHONUNBUFFERED: "1",
  ...overrides,
})

const expectedDiscoveredCatalog = () => [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-9-zenith",
    name: "GPT-9 Zenith",
    thinkingLevels: ["spark"],
  },
]

const azureConfig = (authCommand: string) =>
  `
model = "gpt-5.6-terra"
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai"
wire_api = "responses"

[model_providers.azure.auth]
command = ${JSON.stringify(authCommand)}
args = ["--audience", "codex"]
`.trim()

/** Fake stream: early thread.started, agent_message, turn.completed. */
const successfulTurnStream = (
  threadId = "019fab2c-9466-7432-ad16-9de23f94f2db",
) =>
  [
    `printf '%s\\n' '{"type":"thread.started","thread_id":"${threadId}"}'`,
    `printf '%s\\n' '{"type":"turn.started"}'`,
    `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
  ].join("\n")

const startTurn = (
  binary: string,
  timeout: string,
  onSessionId?: OnSessionId,
  prompt = "test",
  thinkingLevel: string | null = "medium",
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.startTurn({
      cwd: process.cwd(),
      prompt,
      model: "gpt-5.5",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(Effect.provide(provide(binary)))

describe("Codex AgentBackend adapter (readiness inspection)", () => {
  it("discovers Astra and an unseen model across model/list pages, ignoring notifications", async () => {
    await withFakeCodex(async (binary) => {
      const result = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv(),
        }),
      )
      expect(result.backend).toEqual({ id: "codex", label: "Codex Build" })
      expect(result.models).toEqual(expectedDiscoveredCatalog())
      expect(result.warnings ?? []).toEqual([])
    })
  })

  it("inspects when API key login is stored and preserves advertised effort tokens", async () => {
    await withFakeCodex(async (binary) => {
      const result = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_LOGIN: "Logged in using an API key - sk-test",
          }),
        }),
      )
      expect(result.backend.id).toBe("codex")
      const astra = result.models.find((model) => model.id === "gpt-6-astra")
      expect(astra?.thinkingLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
    })
  })

  it("fails inspect with actionable config error when unauthenticated (stderr)", async () => {
    await isolatedFirstPartyEnv(async (environment) => {
      await withExecutable(
        [
          'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
          "echo 'Not logged in' 1>&2",
          "exit 1",
        ].join("\n"),
        async (binary) => {
          const error = await Effect.runPromise(
            inspect(binary, "2 seconds", { environment }).pipe(Effect.flip),
          )
          expect(error).toBeInstanceOf(AgentBackendConfigError)
          if (error instanceof AgentBackendConfigError) {
            expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
            expect(error.message).toContain("codex login")
            expect(error.message).toContain("model_provider")
            expect(error.message).not.toContain("OPENAI_API_KEY")
          }
        },
      )
    })
  })

  it("prefers parsed unauthenticated copy over extra stderr noise", async () => {
    await isolatedFirstPartyEnv(async (environment) => {
      await withExecutable(
        [
          'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
          "echo 'Not logged in' 1>&2",
          "echo 'raw stderr should lose' 1>&2",
          "exit 1",
        ].join("\n"),
        async (binary) => {
          const error = await Effect.runPromise(
            inspect(binary, "2 seconds", { environment }).pipe(Effect.flip),
          )
          expect(error).toBeInstanceOf(AgentBackendConfigError)
          if (error instanceof AgentBackendConfigError) {
            expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
            expect(error.message).not.toContain("raw stderr should lose")
          }
        },
      )
    })
  })

  it("maps non-zero login status without auth markers to exit failure with probe text", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'internal crash' 1>&2",
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.message).toContain("internal crash")
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

  it("inspects Ready from bundled JSON for a valid Azure custom provider without running the token helper", async () => {
    await withCodexHome({}, async (home) => {
      const marker = join(home.CODEX_HOME, "token-ran")
      const authCommand = join(home.CODEX_HOME, "token.sh")
      const argvLog = join(home.CODEX_HOME, "argv.log")
      await writeFile(
        authCommand,
        `#!/bin/sh\necho ran > "${marker}"\necho fake-token\n`,
      )
      await chmod(authCommand, 0o700)
      await writeFile(
        join(home.CODEX_HOME, "config.toml"),
        azureConfig(authCommand),
      )

      await withFakeCodex(async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            environment: {
              ...home,
              FAKE_LOGIN: "Not logged in",
              FAKE_LOGIN_EXIT: "1",
              FAKE_BUNDLED_JSON: JSON.stringify(DEFAULT_BUNDLED_MODELS),
              FAKE_ARGV_LOG: argvLog,
            },
          }),
        )
        expect(result.backend).toEqual({
          id: "codex",
          label: "Codex Build",
        })
        expect(result.models.map((model) => model.id)).toEqual([
          "gpt-6-astra",
          "gpt-5.6-terra",
        ])
        expect(result.models[0]?.thinkingLevels).toEqual([
          "low",
          "max",
          "ultra",
        ])
        expect(result.warnings?.[0]).toContain('custom provider "azure"')
        expect(result.warnings?.[0]).toContain("bundled models")
      })

      expect(await Bun.file(marker).exists()).toBe(false)
      const argv = (await Bun.file(argvLog).text()).trim()
      expect(argv).toContain("login status")
      expect(argv).toContain("debug models")
      expect(argv).toContain("--bundled")
      expect(argv).not.toContain("exec")
      expect(argv).not.toContain("app-server")
    })
  })

  it("keeps default OpenAI Unavailable for the same Not logged in status", async () => {
    await withCodexHome(
      { "config.toml": 'model = "gpt-5.6-terra"\n' },
      async (environment) => {
        await withExecutable(
          [
            'case " $* " in *" login status "*)',
            "  echo 'Not logged in' 1>&2",
            "  exit 1",
            "  ;;",
            "esac",
            'case " $* " in *" debug models "*) exit 30 ;; esac',
            "exit 20",
          ].join("\n"),
          async (binary) => {
            const error = await Effect.runPromise(
              inspect(binary, "2 seconds", { environment }).pipe(Effect.flip),
            )
            expect(error).toBeInstanceOf(AgentBackendConfigError)
            if (error instanceof AgentBackendConfigError) {
              expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
            }
          },
        )
      },
    )
  })

  it("fails inspect with an actionable diagnostic for malformed custom-provider config", async () => {
    await withCodexHome(
      { "config.toml": 'model_provider = "azure"\n' },
      async (environment) => {
        await withExecutable(
          [
            'case " $* " in *" login status "*)',
            "  echo 'Not logged in' 1>&2",
            "  exit 1",
            "  ;;",
            "esac",
            'case " $* " in *" debug models "*) exit 30 ;; esac',
            "exit 20",
          ].join("\n"),
          async (binary) => {
            const error = await Effect.runPromise(
              inspect(binary, "2 seconds", { environment }).pipe(Effect.flip),
            )
            expect(error).toBeInstanceOf(AgentBackendConfigError)
            if (error instanceof AgentBackendConfigError) {
              expect(error.message).toContain("azure")
              expect(error.message).toContain("model_providers")
              expect(error.message).toContain("Recheck Agent Backend")
            }
          },
        )
      },
    )
  })

  it("fails inspect with an actionable diagnostic when custom-provider config validation fails", async () => {
    await withCodexHome(
      {
        "config.toml": azureConfig("/usr/local/bin/fetch-codex-token"),
      },
      async (environment) => {
        await withExecutable(
          [
            'case " $* " in *" exec "*) exit 20 ;; esac',
            'case " $* " in *" login status "*)',
            "  echo 'Not logged in' 1>&2",
            "  exit 1",
            "  ;;",
            "esac",
            'case " $* " in *" debug models "*"--bundled "*)',
            "  echo 'invalid provider configuration' 1>&2",
            "  exit 2",
            "  ;;",
            "esac",
            'case " $* " in *" debug models "*) exit 31 ;; esac',
            "exit 21",
          ].join("\n"),
          async (binary) => {
            const error = await Effect.runPromise(
              inspect(binary, "2 seconds", { environment }).pipe(Effect.flip),
            )
            expect(error).toBeInstanceOf(AgentBackendConfigError)
            if (error instanceof AgentBackendConfigError) {
              expect(error.message).toContain("azure")
              expect(error.message).toContain("codex debug models --bundled")
              expect(error.message).toContain("invalid provider configuration")
            }
          },
        )
      },
    )
  })

  it("does not run debug models or the token helper when stored login is present", async () => {
    await withCodexHome(
      {
        "config.toml": azureConfig("/usr/local/bin/fetch-codex-token"),
      },
      async (home) => {
        const argvLog = join(home.CODEX_HOME, "argv.log")
        await withFakeCodex(async (binary) => {
          const result = await Effect.runPromise(
            inspect(binary, "2 seconds", {
              environment: {
                ...home,
                ...firstPartyDiscoverEnv({ FAKE_ARGV_LOG: argvLog }),
              },
            }),
          )
          expect(result.models).toEqual(expectedDiscoveredCatalog())
          expect(result.warnings ?? []).toEqual([])
        })
        const argv = (await Bun.file(argvLog).text()).trim()
        expect(argv).toContain("login status")
        expect(argv).toContain("app-server")
        expect(argv).not.toContain("debug models")
        expect(argv).not.toContain("exec")
      },
    )
  })

  it("fails inspect when app-server is an unsupported CLI", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_CODEX_MODE: "unsupported",
          }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).toBe(
          CODEX_APP_SERVER_DISCOVERY_FAILED_MESSAGE(
            "unsupported Codex CLI: error: unrecognized subcommand 'app-server'",
          ),
        )
        expect(error.message).toContain(CODEX_MIN_CLI_VERSION)
        expect(error.message).toContain("Recheck Agent Backend")
      }
    })
  })

  it("fails inspect on model/list RPC errors and invalid cursors", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({ FAKE_CODEX_MODE: "rpc-error" }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).toContain("invalid cursor: invalid")
        expect(error.message).toContain("Recheck Agent Backend")
      }
    })
  })

  it("fails inspect when model/list repeats a pagination cursor", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_CODEX_MODE: "repeat-cursor",
          }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).toContain("repeated a pagination cursor")
      }
    })
  })

  it("fails inspect on malformed model/list payloads", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_CODEX_MODE: "malformed-result",
          }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).toContain("missing a data array")
      }
    })
  })

  it("fails inspect when model/list is empty or only hidden", async () => {
    await withFakeCodex(async (binary) => {
      const empty = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({ FAKE_CODEX_MODE: "empty" }),
        }).pipe(Effect.flip),
      )
      expect(empty).toBeInstanceOf(AgentBackendConfigError)
      if (empty instanceof AgentBackendConfigError) {
        expect(empty.message).toContain("no usable models")
      }

      const hidden = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_CODEX_MODE: "hidden-only",
            FAKE_HIDDEN_ENTRY: JSON.stringify(HIDDEN_DAYBREAK_MODEL),
          }),
        }).pipe(Effect.flip),
      )
      expect(hidden).toBeInstanceOf(AgentBackendConfigError)
    })
  })

  it("fails inspect when model/list discovery times out", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "200 millis", {
          environment: firstPartyDiscoverEnv({ FAKE_CODEX_MODE: "hang" }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).toContain("timed out")
        expect(error.message).toContain("Recheck Agent Backend")
      }
    })
  })

  it("terminates the app-server child when inspect is cancelled", async () => {
    await withFakeCodex(async (binary) => {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            inspect(binary, "30 seconds", {
              environment: firstPartyDiscoverEnv({ FAKE_CODEX_MODE: "hang" }),
            }),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(false)
    })
  })

  it("redacts credential-shaped stderr from discovery failures", async () => {
    await withFakeCodex(async (binary) => {
      const error = await Effect.runPromise(
        inspect(binary, "2 seconds", {
          environment: firstPartyDiscoverEnv({
            FAKE_CODEX_MODE: "unsupported",
            FAKE_APP_SERVER_STDERR:
              "token sk-abcdefghijklmnopqrstuvwxyz0123456789",
          }),
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      if (error instanceof AgentBackendConfigError) {
        expect(error.message).not.toContain("sk-")
      }
    })
  })

  it("fails custom-provider inspect when bundled JSON is malformed or empty after projection", async () => {
    await withCodexHome(
      { "config.toml": azureConfig("/usr/local/bin/fetch-codex-token") },
      async (home) => {
        await withFakeCodex(async (binary) => {
          const malformed = await Effect.runPromise(
            inspect(binary, "2 seconds", {
              environment: {
                ...home,
                FAKE_LOGIN: "Not logged in",
                FAKE_LOGIN_EXIT: "1",
                FAKE_BUNDLED_JSON: "not-json",
              },
            }).pipe(Effect.flip),
          )
          expect(malformed).toBeInstanceOf(AgentBackendConfigError)
          if (malformed instanceof AgentBackendConfigError) {
            expect(malformed.message).toBe(
              CODEX_BUNDLED_CATALOG_MALFORMED_MESSAGE(
                "bundled models output is not JSON",
              ),
            )
          }

          const empty = await Effect.runPromise(
            inspect(binary, "2 seconds", {
              environment: {
                ...home,
                FAKE_LOGIN: "Not logged in",
                FAKE_LOGIN_EXIT: "1",
                FAKE_BUNDLED_JSON: JSON.stringify({
                  models: [DEFAULT_BUNDLED_MODELS.models[1]],
                }),
              },
            }).pipe(Effect.flip),
          )
          expect(empty).toBeInstanceOf(AgentBackendConfigError)
          if (empty instanceof AgentBackendConfigError) {
            expect(empty.message).toBe(CODEX_BUNDLED_CATALOG_EMPTY_MESSAGE)
          }
        })
      },
    )
  })

  it("fails inspect when the binary is missing", async () => {
    const missing = join(tmpdir(), `codex-missing-${Date.now()}`)
    const error = await Effect.runPromise(inspect(missing).pipe(Effect.flip))
    expect(error).toBeInstanceOf(AgentBackendNotInstalledError)
    if (error instanceof AgentBackendNotInstalledError) {
      expect(error.binary).toBe(missing)
      expect(error.message).toContain(
        `Codex Build CLI "${missing}" was not found on the Harness PATH.`,
      )
      expect(error.message).toContain("restart the Harness")
    }
  })
})

describe("Codex AgentBackend adapter (Agent Turns)", () => {
  it("executes a new model id and unfamiliar effort without rewriting them", async () => {
    await withExecutable(
      [
        'case " $* " in *" --model gpt-6-astra "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" model_reasoning_effort=ultra "*) ;; *) exit 21 ;; esac',
        successfulTurnStream("astra-thread"),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "test",
              model: "gpt-6-astra",
              thinkingLevel: "ultra",
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("astra-thread")
      },
    )
  })

  it("requires exec --json, danger-full-access, and never-approval on every turn", async () => {
    await withExecutable(
      [
        'case " $* " in *" exec "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" --json "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" danger-full-access "*) ;; *) exit 22 ;; esac',
        'case " $* " in *" approval_policy=never "*) ;; *) exit 23 ;; esac',
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("ok")
        expect(result.sessionId).toBe("019fab2c-9466-7432-ad16-9de23f94f2db")
      },
    )
  })

  it("sends a large single-line prompt through stdin instead of argv", async () => {
    // Single-line and past the argv byte limit: on argv this spawn fails with
    // an opaque platform error rather than reaching the CLI at all.
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    await withExecutable(
      [
        // `-` is the only positional prompt; the body arrives on stdin.
        'case " $* " in *" -- - ") ;; *) exit 30 ;; esac',
        "input=$(cat)",
        `[ \${#input} -eq ${prompt.length} ] || exit 31`,
        'case "$input" in "Fix x"*) ;; *) exit 32 ;; esac',
        successfulTurnStream("thread-large"),
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "10 seconds", undefined, prompt)),
        ).resolves.toEqual({
          sessionId: "thread-large",
          assistantText: "ok",
        })
      },
    )
  })

  it("collects ordered agent_message text and ignores other item types", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-abc"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"think"}}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first"}}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":" second"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.sessionId).toBe("thread-abc")
        expect(result.assistantText).toBe("first second")
      },
    )
  })

  it("notifies onSessionId from thread.started while the first turn is still running", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"early-thread-id"}'`,
        "sleep 0.4",
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"done"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const observed = await Effect.runPromise(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<string>()
            const fiber = yield* Effect.forkChild(
              startTurn(binary, "5 seconds", (sessionId) =>
                Deferred.succeed(deferred, sessionId).pipe(Effect.asVoid),
              ),
            )
            const earlySessionId = yield* Deferred.await(deferred)
            const stillRunning = fiber.pollUnsafe() === undefined
            const result = yield* Fiber.await(fiber)
            return { earlySessionId, stillRunning, result }
          }),
        )

        expect(observed.earlySessionId).toBe("early-thread-id")
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe(observed.earlySessionId)
        }
      },
    )
  })

  it("resumes by session id and restates model and reasoning effort", async () => {
    await withExecutable(
      [
        // First turn: start
        'case " $* " in *" resume "*)',
        '  case " $* " in *" gpt-5.6-sol "*) ;; *) exit 30 ;; esac',
        '  case " $* " in *" model_reasoning_effort=high "*) ;; *) exit 31 ;; esac',
        '  case " $* " in *" thread-from-start "*) ;; *) exit 32 ;; esac',
        successfulTurnStream("thread-from-start"),
        "  exit 0",
        "  ;;",
        "esac",
        // Start turn: no resume
        'case " $* " in *" resume "*) exit 33 ;; esac',
        'case " $* " in *" gpt-5.5 "*) ;; *) exit 34 ;; esac',
        'case " $* " in *" model_reasoning_effort=low "*) ;; *) exit 35 ;; esac',
        successfulTurnStream("thread-from-start"),
      ].join("\n"),
      async (binary) => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            const started = yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "first",
              model: "gpt-5.5",
              thinkingLevel: "low",
              timeout: "2 seconds",
            })
            const continued = yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: started.sessionId,
              prompt: "second",
              model: "gpt-5.6-sol",
              thinkingLevel: "high",
              timeout: "2 seconds",
            })
            return { started, continued }
          }).pipe(Effect.provide(provide(binary))),
        )

        expect(outcome.started.sessionId).toBe("thread-from-start")
        expect(outcome.continued.sessionId).toBe(outcome.started.sessionId)
        expect(outcome.continued.assistantText).toBe("ok")
      },
    )
  })

  it("omits model_reasoning_effort when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'case " $* " in *" model_reasoning_effort="*) exit 11 ;; esac',
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            startTurn(binary, "2 seconds", undefined, "test", null),
          ),
        ).resolves.toMatchObject({ assistantText: "ok" })
      },
    )
  })

  it("continueTurn succeeds without a second thread.started using seeded session id", async () => {
    await withExecutable(
      [
        'case " $* " in *" resume "*) ;; *) exit 50 ;; esac',
        'case " $* " in *" seeded-thread "*) ;; *) exit 51 ;; esac',
        // No thread.started — durable ID comes from continueTurn input.
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"resumed-ok"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "seeded-thread",
              prompt: "continue without stream session event",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("seeded-thread")
        expect(result.assistantText).toBe("resumed-ok")
      },
    )
  })

  it("prefixes /review into the prompt on continueTurn", async () => {
    await withExecutable(
      [
        'case " $* " in *"/review"*) ;; *) exit 40 ;; esac',
        successfulTurnStream("review-thread"),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "review-thread",
              command: "/review",
              prompt: "Review uncommitted worktree changes.",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("review-thread")
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("classifies a turn.failed credential rejection as terminal_auth_error", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"auth-thread"}'`,
        `printf '%s\\n' '{"type":"turn.failed","error":{"message":"ExpiredToken: token has expired"}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.classification).toBe("terminal_auth_error")
          expect(error.message).toBe("ExpiredToken: token has expired")
        }
      },
    )
  })

  it("maps turn.failed to exit failure with observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"fail-thread"}'`,
        `printf '%s\\n' '{"type":"turn.failed","error":{"message":"boom"}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toBe("boom")
          expect(error.sessionId).toBe("fail-thread")
        }
      },
    )
  })

  it("maps nonzero exit with observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"exit-thread"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"x"}}'`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.message).toBe("Codex Build failed with exit code 7")
          expect(error.sessionId).toBe("exit-thread")
        }
      },
    )
  })

  it("maps timeout while retaining session id from thread.started", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"timeout-thread"}'`,
        "sleep 10",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendTimeoutError)
        if (error instanceof AgentBackendTimeoutError) {
          expect(error.timeoutMs).toBe(200)
          expect(error.sessionId).toBe("timeout-thread")
        }
      },
    )
  })

  it("fails when terminal turn.completed is missing", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"only"}}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails on malformed stream lines", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'`,
        "echo not-json",
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails startTurn when thread.started never arrives", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"x"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        // Missing session id: either SessionIdMissing or malformed after fold.
        expect(
          error instanceof AgentBackendSessionIdMissingError ||
            error instanceof AgentBackendMalformedOutputError,
        ).toBe(true)
      },
    )
  })

  it("cancels the process tree on fiber interruption", async () => {
    await withExecutable(
      ["trap 'exit 0' TERM", "sleep 30"].join("\n"),
      async (binary) => {
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              startTurn(binary, "30 seconds"),
            )
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
            return yield* Fiber.await(fiber)
          }),
        )
        expect(Exit.isSuccess(exit)).toBe(false)
      },
    )
  })
})
