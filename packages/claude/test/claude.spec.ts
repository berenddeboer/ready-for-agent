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
  AgentBackendTimeoutError,
  type OnSessionId,
  PROMPT_ARGV_BYTE_LIMIT,
} from "@ready-for-agent/agent-backend"
import {
  CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE,
  CLAUDE_STATIC_CATALOG,
  CLAUDE_THINKING_LEVELS,
  CLAUDE_UNAUTHENTICATED_MESSAGE,
  Claude,
  type ClaudeDiscoverBedrockModels,
  type ClaudeLayerOptions,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "claude-effect-test-"))
  const path = join(directory, "claude")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const provide = (
  binary: string,
  options: Pick<
    ClaudeLayerOptions,
    "environment" | "discoverBedrockModels"
  > = {},
) =>
  Claude.layer({
    binary,
    ...options,
  }).pipe(Layer.provide(BunServices.layer))

const inspect = (
  binary: string,
  timeout = "2 seconds",
  options: Pick<
    ClaudeLayerOptions,
    "environment" | "discoverBedrockModels"
  > = {},
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.inspect({
      cwd: process.cwd(),
      timeout,
    })
  }).pipe(Effect.provide(provide(binary, options)))

const fakeDiscover =
  (
    result: {
      models: ReadonlyArray<{
        id: string
        thinkingLevels: readonly string[]
        name?: string | null
        kind?: string | null
      }>
      warning: string | null
    },
    onCall?: (input: {
      readonly environment: Readonly<Record<string, string | undefined>>
      readonly timeout?: unknown
    }) => void,
  ): ClaudeDiscoverBedrockModels =>
  (input) => {
    onCall?.(input)
    return Effect.succeed({
      models: result.models.map((model) => ({
        id: model.id,
        thinkingLevels: [...model.thinkingLevels],
        ...(model.name !== undefined && model.name !== null
          ? { name: model.name }
          : {}),
        ...(model.kind !== undefined && model.kind !== null
          ? { kind: model.kind }
          : {}),
      })),
      warning: result.warning,
    })
  }

const captureSessionScript = [
  'sid=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$arg"; fi',
  '  prev="$arg"',
  "done",
].join("\n")

/** Fake stream: system init, assistant text, terminal result. */
const successfulTurnStream = (sessionId = "$sid") =>
  [
    `printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"${sessionId}\\"}"`,
    `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"${sessionId}\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok\\"}]}}"`,
    `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"session_id\\":\\"${sessionId}\\",\\"is_error\\":false,\\"result\\":\\"ok\\"}"`,
  ].join("\n")

const startTurn = (
  binary: string,
  timeout: string,
  onSessionId?: OnSessionId,
  prompt = "test",
  thinkingLevel: string | null = "medium",
  environment?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.startTurn({
      cwd: process.cwd(),
      prompt,
      model: "sonnet",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(
    Effect.provide(
      provide(binary, environment !== undefined ? { environment } : {}),
    ),
  )

describe("Claude AgentBackend adapter (readiness inspection)", () => {
  it("inspects authenticated CLI via JSON auth status (real CLI shape)", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        // Env must force auto-update off on inspect too.
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 21; fi',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"op@example.com"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend).toEqual({
          id: "claude",
          label: "Claude Code",
        })
        // Issue #819: provider identity originates from apiProvider, not env.
        expect(result.provider).toEqual({
          id: "firstParty",
          label: "First-party",
        })
        expect(result.models).toEqual(
          CLAUDE_STATIC_CATALOG.map((model) => ({
            id: model.id,
            thinkingLevels: [...model.thinkingLevels],
          })),
        )
        expect(result.models.map((m) => m.id)).toEqual([
          "haiku",
          "sonnet",
          "opus",
          "fable",
        ])
        for (const model of result.models) {
          expect(model.thinkingLevels).toEqual([
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ])
          expect(model.thinkingLevels).not.toContain("ultracode")
        }
      },
    )
  })

  it("inspects Ready Bedrock with system and application profile catalog (issues #820 / #821)", async () => {
    const systemId = "us.anthropic.claude-sonnet-4-6"
    const applicationArn =
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"
    const catalog = [
      {
        id: systemId,
        name: "US Anthropic Claude Sonnet 4.6",
        kind: "SYSTEM_DEFINED",
        thinkingLevels: [...CLAUDE_THINKING_LEVELS],
      },
      {
        id: applicationArn,
        name: "My Org Sonnet",
        kind: "APPLICATION",
        thinkingLevels: [...CLAUDE_THINKING_LEVELS],
      },
    ]
    let discoveryCalls = 0
    let seenTimeout: unknown
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 21; fi',
        // Real Claude Code Bedrock shape (issue #801 / epic #799).
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            discoverBedrockModels: fakeDiscover(
              {
                models: catalog,
                warning: null,
              },
              (input) => {
                discoveryCalls += 1
                seenTimeout = input.timeout
              },
            ),
          }),
        )
        // Inspect must pass its timeout budget into discovery (review #820).
        expect(seenTimeout).toBe("2 seconds")
        expect(result.backend).toEqual({
          id: "claude",
          label: "Claude Code",
        })
        // Issue #819: apiProvider bedrock → Amazon Bedrock operator label.
        expect(result.provider).toEqual({
          id: "bedrock",
          label: "Amazon Bedrock",
        })
        // Issues #820 / #821: system IDs + application ARNs with name/kind.
        expect(result.models).toEqual(catalog)
        expect(result.models.map((m) => m.id)).not.toContain("haiku")
        expect(result.models.map((m) => m.id)).not.toContain("sonnet")
        expect(result.models.map((m) => m.id)).not.toContain("opus")
        expect(result.models.map((m) => m.id)).not.toContain("fable")
        for (const model of result.models) {
          expect(model.thinkingLevels).toEqual([...CLAUDE_THINKING_LEVELS])
        }
        expect(result.warnings).toEqual([])
        expect(discoveryCalls).toBe(1)
      },
    )
  })

  it("keeps Ready with warning when Bedrock discovery fails (issue #820)", async () => {
    const warning =
      "Could not list Amazon Bedrock inference profiles: access denied (need bedrock:ListInferenceProfiles on the harness IAM principal). Fix AWS configuration (credentials, region, bedrock:ListInferenceProfiles), then Recheck Agent Backend."
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            discoverBedrockModels: fakeDiscover({
              models: [],
              warning,
            }),
          }),
        )
        expect(result.provider).toEqual({
          id: "bedrock",
          label: "Amazon Bedrock",
        })
        expect(result.models).toEqual([])
        expect(result.warnings).toEqual([warning])
        // Not Unavailable — discovery is catalog-only.
        expect(result.backend.id).toBe("claude")
      },
    )
  })

  it("first-party Ready never calls Bedrock discovery and keeps static aliases", async () => {
    let discoveryCalls = 0
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            discoverBedrockModels: fakeDiscover(
              {
                models: [
                  {
                    id: "should-not-appear",
                    thinkingLevels: [...CLAUDE_THINKING_LEVELS],
                  },
                ],
                warning: null,
              },
              () => {
                discoveryCalls += 1
              },
            ),
          }),
        )
        expect(result.provider).toEqual({
          id: "firstParty",
          label: "First-party",
        })
        expect(result.models.map((m) => m.id)).toEqual([
          "haiku",
          "sonnet",
          "opus",
          "fable",
        ])
        expect(discoveryCalls).toBe(0)
        expect(result.warnings).toEqual([])
      },
    )
  })

  it("does not infer Bedrock provider from CLAUDE_CODE_USE_BEDROCK alone", async () => {
    // Stale/ineffective env flag must not produce a Bedrock label when Claude
    // reports first-party (issue #819).
    let discoveryCalls = 0
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'if [ "$CLAUDE_CODE_USE_BEDROCK" != "1" ]; then exit 30; fi',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            environment: {
              PATH: process.env.PATH,
              CLAUDE_CODE_USE_BEDROCK: "1",
            },
            discoverBedrockModels: fakeDiscover(
              { models: [], warning: null },
              () => {
                discoveryCalls += 1
              },
            ),
          }),
        )
        expect(result.provider).toEqual({
          id: "firstParty",
          label: "First-party",
        })
        expect(result.provider?.label).not.toContain("Bedrock")
        expect(discoveryCalls).toBe(0)
      },
    )
  })

  it("forwards Bedrock and AWS env on inspect while forcing DISABLE_AUTOUPDATER", async () => {
    // Issue #803: fake CLI proves layer-provided Bedrock/AWS vars reach the
    // child, and auto-update stays disabled under Harness.
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 21; fi',
        'if [ "$CLAUDE_CODE_USE_BEDROCK" != "1" ]; then exit 30; fi',
        'if [ "$AWS_REGION" != "us-east-1" ]; then exit 31; fi',
        'if [ "$AWS_ACCESS_KEY_ID" != "AKIAEXAMPLE" ]; then exit 32; fi',
        'if [ "$AWS_SECRET_ACCESS_KEY" != "secret" ]; then exit 33; fi',
        'if [ "$AWS_SESSION_TOKEN" != "session" ]; then exit 34; fi',
        'if [ "$AWS_PROFILE" != "bedrock-op" ]; then exit 35; fi',
        'if [ "$AWS_BEARER_TOKEN_BEDROCK" != "bedrock-bearer" ]; then exit 36; fi',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          inspect(binary, "2 seconds", {
            environment: {
              PATH: process.env.PATH,
              CLAUDE_CODE_USE_BEDROCK: "1",
              AWS_REGION: "us-east-1",
              AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
              AWS_SECRET_ACCESS_KEY: "secret",
              AWS_SESSION_TOKEN: "session",
              AWS_PROFILE: "bedrock-op",
              AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
            },
            discoverBedrockModels: fakeDiscover({
              models: [
                {
                  id: "us.anthropic.claude-sonnet-4-6",
                  thinkingLevels: [...CLAUDE_THINKING_LEVELS],
                },
              ],
              warning: null,
            }),
          }),
        )
        expect(result.backend).toEqual({
          id: "claude",
          label: "Claude Code",
        })
        // Bedrock inspect uses discovered profiles, not floating aliases (#820).
        expect(result.models.map((m) => m.id)).toEqual([
          "us.anthropic.claude-sonnet-4-6",
        ])
        expect(result.provider).toEqual({
          id: "bedrock",
          label: "Amazon Bedrock",
        })
      },
    )
  })

  it("fails inspect with actionable config error when unauthenticated", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "printf '%s\\n' '{\"loggedIn\":false}'",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("claude auth login")
          expect(error.message).toContain("ANTHROPIC_API_KEY")
        }
      },
    )
  })

  it("keeps first-party loggedIn false on the login/API-key path (not Bedrock)", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":false,"authMethod":null,"apiProvider":"firstParty"}\'',
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("claude auth login")
          expect(error.message).toContain("ANTHROPIC_API_KEY")
          expect(error.message.toLowerCase()).not.toContain("bedrock")
        }
      },
    )
  })

  it("fails Bedrock readiness with AWS/Bedrock ConfigError (not claude auth login)", async () => {
    // Issue #802: Bedrock provider path must not steer operators to first-party
    // `claude auth login` when the readiness probe reports Bedrock unusable.
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":false,"authMethod":"third_party","apiProvider":"bedrock"}\'',
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE)
          expect(error.message.toLowerCase()).toContain("bedrock")
          expect(error.message).toMatch(/AWS|aws/)
          expect(error.message).not.toContain("claude auth login")
          expect(error.message).not.toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          // Issue #819: first Unavailable still carries provider identity.
          expect(error.provider).toEqual({
            id: "bedrock",
            label: "Amazon Bedrock",
          })
        }
      },
    )
  })

  it("attaches First-party provider on unauthenticated ConfigError", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":false,"authMethod":null,"apiProvider":"firstParty"}\'',
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          expect(error.provider).toEqual({
            id: "firstParty",
            label: "First-party",
          })
        }
      },
    )
  })

  it("maps non-zero auth status without auth markers to config error with probe text", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "echo 'internal crash' 1>&2",
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toContain("exit 7")
          expect(error.message).toContain("internal crash")
          expect(error.message).not.toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
        }
      },
    )
  })

  it("fails inspect when auth status output is malformed", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "echo 'something unexpected without auth markers'",
        "exit 0",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails inspect when the binary is missing", async () => {
    const missing = join(tmpdir(), `claude-missing-${Date.now()}`)
    const error = await Effect.runPromise(inspect(missing).pipe(Effect.flip))
    expect(error).toBeInstanceOf(AgentBackendNotInstalledError)
    if (error instanceof AgentBackendNotInstalledError) {
      expect(error.binary).toBe(missing)
      expect(error.message).toContain(
        `Claude Code CLI "${missing}" was not found on the Harness PATH.`,
      )
      expect(error.message).toContain("restart the Harness")
    }
  })
})

describe("Claude AgentBackend adapter (Agent Turns)", () => {
  it("requires print mode, stream-json, verbose, permissions skip, and DISABLE_AUTOUPDATER", async () => {
    await withExecutable(
      [
        'case " $* " in *" -p "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" stream-json "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" --verbose "*) ;; *) exit 22 ;; esac',
        'case " $* " in *" --dangerously-skip-permissions "*) ;; *) exit 23 ;; esac',
        'case " $* " in *" --bare "*) exit 24 ;; esac',
        'case " $* " in *" --continue "*) exit 25 ;; esac',
        'case " $* " in *" --fork-session "*) exit 26 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 27; fi',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("ok")
        expect(result.sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
      },
    )
  })

  it("forwards Bedrock and AWS env on turns while forcing DISABLE_AUTOUPDATER", async () => {
    // Issue #803: same env preservation as inspect for Agent Turn spawns.
    await withExecutable(
      [
        'case " $* " in *" -p "*) ;; *) exit 20 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 27; fi',
        'if [ "$CLAUDE_CODE_USE_BEDROCK" != "1" ]; then exit 40; fi',
        'if [ "$AWS_REGION" != "eu-west-1" ]; then exit 41; fi',
        'if [ "$AWS_ACCESS_KEY_ID" != "AKIAEXAMPLE" ]; then exit 42; fi',
        'if [ "$AWS_DEFAULT_REGION" != "eu-west-1" ]; then exit 43; fi',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          startTurn(binary, "2 seconds", undefined, "test", "medium", {
            PATH: process.env.PATH,
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_REGION: "eu-west-1",
            AWS_DEFAULT_REGION: "eu-west-1",
            AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
          }),
        )
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("collects terminal result text", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"first\\"}]}}"`,
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":false,\\"result\\":\\"final answer\\"}"`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("final answer")
      },
    )
  })

  it("notifies onSessionId with the preassigned UUID before process exit", async () => {
    await withExecutable(
      [captureSessionScript, "sleep 0.4", successfulTurnStream()].join("\n"),
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

        expect(observed.earlySessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe(observed.earlySessionId)
        }
      },
    )
  })

  it("passes --session-id on start and --resume on continue with model/effort restated", async () => {
    await withExecutable(
      [
        // Continue path first when --resume is present.
        'case " $* " in *" --resume "*)',
        '  case " $* " in *" --model opus "*) ;; *) exit 30 ;; esac',
        '  case " $* " in *" --effort high "*) ;; *) exit 31 ;; esac',
        '  case " $* " in *" --session-id "*) exit 32 ;; esac',
        '  case " $* " in *" --continue "*) exit 33 ;; esac',
        '  case " $* " in *" --fork-session "*) exit 34 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
        "  exit 0",
        "  ;;",
        "esac",
        // Start turn: no resume
        'case " $* " in *" --resume "*) exit 35 ;; esac',
        'case " $* " in *" --session-id "*) ;; *) exit 36 ;; esac',
        'case " $* " in *" --model sonnet "*) ;; *) exit 37 ;; esac',
        'case " $* " in *" --effort low "*) ;; *) exit 38 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            const started = yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "first",
              model: "sonnet",
              thinkingLevel: "low",
              timeout: "2 seconds",
            })
            const continued = yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: started.sessionId,
              prompt: "second",
              model: "opus",
              thinkingLevel: "high",
              timeout: "2 seconds",
            })
            return { started, continued }
          }).pipe(Effect.provide(provide(binary))),
        )

        expect(outcome.continued.sessionId).toBe(outcome.started.sessionId)
        expect(outcome.continued.assistantText).toBe("ok")
      },
    )
  })

  it("omits --effort when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'case " $* " in *" --effort "*) exit 11 ;; esac',
        captureSessionScript,
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

  it("sends a large single-line prompt through stdin instead of argv", async () => {
    // Single-line and past the argv byte limit: on argv this spawn fails with
    // an opaque platform error rather than reaching Claude Code at all.
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    await withExecutable(
      [
        "input=$(cat)",
        `[ \${#input} -eq ${prompt.length} ] || exit 60`,
        'case "$input" in "Fix x"*) ;; *) exit 61 ;; esac',
        // No positional prompt: argv must not carry an end-of-options prompt.
        'case " $* " in *" -- "*) exit 62 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "10 seconds", undefined, prompt)),
        ).resolves.toMatchObject({ assistantText: "ok" })
      },
    )
  })

  it("passes free-text / Bedrock model ids through as --model on turns (issue #806)", async () => {
    const freeText =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile"
    await withExecutable(
      [
        'case " $* " in *" --model "*) ;; *) exit 50 ;; esac',
        // Exact free-text id must reach argv without alias rewrite.
        `case " $* " in *" --model ${freeText} "*) ;; *) exit 51 ;; esac`,
        'case " $* " in *" --effort max "*) ;; *) exit 52 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "bedrock free-text model",
              model: freeText,
              thinkingLevel: "max",
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("passes system profile IDs and application ARNs unchanged as --model (issue #821)", async () => {
    const cases = [
      "us.anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/org-sonnet",
      "custom.operator.typed-id-v1:0",
    ] as const
    for (const modelId of cases) {
      await withExecutable(
        [
          'case " $* " in *" --model "*) ;; *) exit 50 ;; esac',
          `case " $* " in *" --model ${modelId} "*) ;; *) exit 51 ;; esac`,
          'case " $* " in *" --effort high "*) ;; *) exit 52 ;; esac',
          captureSessionScript,
          successfulTurnStream(),
        ].join("\n"),
        async (binary) => {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const backend = yield* AgentBackend
              return yield* backend.startTurn({
                cwd: process.cwd(),
                prompt: "bedrock catalog model unchanged",
                model: modelId,
                thinkingLevel: "high",
                timeout: "2 seconds",
              })
            }).pipe(Effect.provide(provide(binary))),
          )
          expect(result.assistantText).toBe("ok")
        },
      )
    }
  })

  it("prefixes /review into the prompt on continueTurn", async () => {
    await withExecutable(
      [
        'case " $* " in *"/review"*) ;; *) exit 40 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "11111111-1111-4111-8111-111111111111",
              command: "/review",
              prompt: "Review uncommitted worktree changes.",
              model: "sonnet",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111")
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("maps result is_error to exit failure with known session", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"error\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":true,\\"error\\":\\"boom\\"}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("maps nonzero exit with known session", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"x\\"}]}}"`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("maps timeout while retaining preassigned session id", async () => {
    await withExecutable(
      [captureSessionScript, "sleep 10"].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendTimeoutError)
        if (error instanceof AgentBackendTimeoutError) {
          expect(error.timeoutMs).toBe(200)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("fails when terminal result event is missing", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"only\\"}]}}"`,
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
        captureSessionScript,
        "echo not-json",
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":false,\\"result\\":\\"x\\"}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails on session id mismatch in result event", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"result","session_id":"00000000-0000-4000-8000-000000000099","is_error":false,"result":"x"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
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
