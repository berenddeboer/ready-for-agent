import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitPostconditionError,
  CommitPublicationCopyError,
  CommitSessionContextMissingError,
  CommitStartingCommitMissingError,
  CommitWorktreeContextMissingError,
  commit,
  formatPublicationCommitMessage,
  makeWorkItemId,
  normalizePublicationCopy,
  parsePublicationCopyResult,
  publicationCopyFromCommitMessage,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const sampleCopy = {
  publicationTitle: "feat: add widgets endpoint",
  publicationBody:
    "Adds the widgets HTTP endpoint used by the dashboard.\n\nVerified with unit tests.\n\nCloses #91",
}

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  issueNumber: 91,
  issueTitle: "Add widgets endpoint",
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly startTurn?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continueTurn?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
}) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: (input) =>
        impl.startTurn?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continueTurn: (input) =>
        impl.continueTurn?.(input) ??
        Effect.succeed({ sessionId: "ses_commit_default", assistantText: "" }),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, AgentBackend>,
  opencodeLayer: Layer.Layer<AgentBackend, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`,
    )
  }
  return stdout.trim()
}

const initWorktree = async (root: string) => {
  await git(root, ["init", "-b", "main"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test"])
  // Local-only: global commit.gpgsign would hang harness-owned git commit on
  // pinentry during tests (production worktrees inherit the operator's config).
  await git(root, ["config", "commit.gpgsign", "false"])
  await writeFile(join(root, "README.md"), "# widgets\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "--no-verify", "-m", "initial"])
  return git(root, ["rev-parse", "HEAD"])
}

const withTempRepo = async (
  assert: (root: string, startingOid: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-commit-"))
  try {
    const startingOid = await initWorktree(root)
    await assert(root, startingOid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const publicationResultLine = (title: string, body: string) =>
  `READY_FOR_AGENT_RESULT: PUBLICATION_COPY ${JSON.stringify({ title, body })}`

describe("publication copy parsing", () => {
  it("parses JSON on the result line and normalizes Closes", () => {
    const parsed = parsePublicationCopyResult(
      [
        "Here is the copy.",
        publicationResultLine(
          "feat: widgets",
          "Why we needed this.\n\nCloses #91",
        ),
      ].join("\n"),
    )
    expect(parsed).toEqual({
      title: "feat: widgets",
      body: "Why we needed this.\n\nCloses #91",
    })
    expect(normalizePublicationCopy(parsed!, 91)).toEqual({
      title: "feat: widgets",
      body: "Why we needed this.\n\nCloses #91",
    })
  })

  it("rejects blank, generic, or missing results", () => {
    expect(parsePublicationCopyResult("no marker")).toBeNull()
    expect(
      parsePublicationCopyResult(
        `${publicationResultLine("t", "b")}\n${publicationResultLine("t2", "b2")}`,
      ),
    ).toBeNull()
    expect(
      normalizePublicationCopy(
        {
          title: "  ",
          body: "something substantive enough",
        },
        1,
      ),
    ).toBeNull()
    expect(
      normalizePublicationCopy(
        {
          title: "feat: x",
          body: "Automated draft pull request for GitHub issue #1.",
        },
        1,
      ),
    ).toBeNull()
  })

  it("formats commit message from title and body", () => {
    expect(
      formatPublicationCommitMessage({
        title: "feat: x",
        body: "Why\n\nCloses #1",
      }),
    ).toBe("feat: x\n\nWhy\n\nCloses #1")
  })

  it("seeds from a legacy commit body that is only Closes without doubling", () => {
    const seeded = publicationCopyFromCommitMessage(
      "prior commit\n\nCloses #91",
      91,
    )
    expect(seeded).not.toBeNull()
    expect(seeded!.title).toBe("prior commit")
    // Body matches the commit body (single Closes); no invented prose.
    expect(seeded!.body).toBe("Closes #91")
    expect(seeded!.body.match(/Closes #91/g)?.length).toBe(1)
    expect(formatPublicationCommitMessage(seeded!)).toBe(
      "prior commit\n\nCloses #91",
    )
  })

  it("strips trailing-period and list-form closing references when normalizing", () => {
    const withPeriod = normalizePublicationCopy(
      {
        title: "feat: widgets",
        body: "Adds widgets.\n\nCloses #7.",
      },
      7,
    )
    expect(withPeriod).not.toBeNull()
    expect(withPeriod!.body.match(/Closes #7/g)?.length).toBe(1)
    expect(withPeriod!.body).not.toContain("Closes #7.")

    const listForm = normalizePublicationCopy(
      {
        title: "feat: widgets",
        body: "Adds widgets.\n\n- Closes #7",
      },
      7,
    )
    expect(listForm).not.toBeNull()
    expect(listForm!.body.match(/Closes #7/g)?.length).toBe(1)
  })
})

describe("commit", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(commit(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-commit-missing-worktree")
    const error = await run(commit(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitInvalidWorktreeContextError)
  })

  it("rejects missing starting commit OID", () =>
    withTempRepo(async (root) => {
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: null,
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitStartingCommitMissingError)
    }))

  it("native commit uses persisted publication copy without a generation turn", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      let continued = 0
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
            issueNumber: 2039,
            issueTitle: "Fix the widgets path",
            publicationTitle: "fix: widgets path",
            publicationBody:
              "Corrects the widgets route used by the API.\n\nCloses #2039",
          }),
        ),
        stubOpencode({
          continueTurn: () => {
            continued += 1
            return Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "",
            })
          },
        }),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("fix: widgets path")
      expect(result.publicationBody).toContain("Corrects the widgets route")
      expect(result.publicationBody).toContain("Closes #2039")
      expect(continued).toBe(0)

      const count = await git(root, [
        "rev-list",
        "--count",
        `${startingOid}..HEAD`,
      ])
      expect(count).toBe("1")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain("fix: widgets path")
      expect(message).toContain("Corrects the widgets route")
      expect(message).toContain("Closes #2039")
      expect(message).not.toContain("Automated draft pull request")
      expect(await git(root, ["status", "--porcelain"])).toBe("")
    }))

  it("generates publication copy once then commits natively", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const prompts: string[] = []

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            issueNumber: 42,
            sessionId: "ses_from_implement",
          }),
        ),
        stubOpencode({
          continueTurn: (input) => {
            prompts.push(input.prompt)
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: publicationResultLine(
                "feat: implement widgets",
                "Implements widgets as requested.\n\nVerified via local checks.",
              ),
            })
          },
        }),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("feat: implement widgets")
      expect(result.publicationBody).toContain("Implements widgets")
      expect(result.publicationBody).toContain("Closes #42")
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Write copy only")
      expect(prompts[0]).toContain("Do not edit files")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message.startsWith("feat: implement widgets")).toBe(true)
      expect(message).toContain("Closes #42")
    }))

  it("retries generation once on malformed copy then fails without placeholder fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      let calls = 0
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            issueNumber: 9,
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: () => {
            calls += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "not a valid result",
            })
          },
        }),
      )
      expect(error).toBeInstanceOf(CommitPublicationCopyError)
      expect(calls).toBe(2)
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("0")
    }))

  it("native commit leaves untracked harness artifacts uncommitted", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await mkdir(join(root, ".ready-for-agent"), { recursive: true })
      await writeFile(join(root, ".ready-for-agent", "noise.log"), "harness\n")

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            issueNumber: 2039,
            ...sampleCopy,
            publicationBody:
              "Corrects the widgets route used by the API.\n\nCloses #2039",
            publicationTitle: "fix: widgets path",
          }),
        ),
      )

      expect(result.completion).toBe("native")
      const status = await git(root, ["status", "--porcelain"])
      expect(status).toContain(".ready-for-agent/")
      expect(status).not.toContain("feature.ts")
    }))

  it("excludes harness artifacts even when Pre-Commit already staged them", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await mkdir(join(root, ".ready-for-agent"), { recursive: true })
      await writeFile(join(root, ".ready-for-agent", "noise.log"), "harness\n")
      await git(root, ["add", "-A"])

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            issueNumber: 12,
            publicationTitle: "chore: keep diagnostics out",
            publicationBody:
              "Ensures harness artifacts stay uncommitted.\n\nCloses #12",
          }),
        ),
      )

      expect(result.completion).toBe("native")
      const tree = await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])
      expect(tree).toContain("feature.ts")
      expect(tree).not.toContain(".ready-for-agent")
      const status = await git(root, ["status", "--porcelain"])
      expect(status).toContain(".ready-for-agent/")
    }))

  it("reuses an existing postcondition and seeds copy from the commit when absent", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "prior commit\n\nCloses #91",
      ])
      const headBefore = await git(root, ["rev-parse", "HEAD"])

      let continued = 0
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
          }),
        ),
        stubOpencode({
          continueTurn: () => {
            continued += 1
            return Effect.succeed({
              sessionId: "ses",
              assistantText: "",
            })
          },
        }),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("prior commit")
      expect(result.publicationBody).toContain("Closes #91")
      expect(result.publicationBody.match(/Closes #91/g)?.length).toBe(1)
      expect(continued).toBe(0)
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore)
    }))

  it("prefers HEAD over stale persisted copy when already committed", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "feat: actual head message\n\nPolicy-fixed body\n\nCloses #91",
      ])

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "stale title from mid-persist",
            publicationBody: "Stale body that must not win.\n\nCloses #91",
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("feat: actual head message")
      expect(result.publicationBody).toContain("Policy-fixed body")
      expect(result.publicationBody).not.toContain("Stale body")
    }))

  it("falls back to one repair Agent Turn when the commit-msg hook rejects the message", () =>
    withTempRepo(async (root, startingOid) => {
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "commit-msg")
      await writeFile(
        hookPath,
        `#!/bin/sh
if ! grep -q '^feat:' "$1"; then
  echo "commitlint: subject must start with feat:" >&2
  exit 1
fi
`,
      )
      await chmod(hookPath, 0o755)

      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      let continued: {
        sessionId: string
        prompt: string
        cwd: string
      } | null = null
      let agentCalls = 0

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
            issueNumber: 2039,
            publicationTitle: "Add feature without conventional prefix",
            publicationBody: "Adds the feature file.\n\nCloses #2039",
            model: "opencode/commit-model",
            thinkingLevel: "max",
            maxDuration: Duration.minutes(10),
          }),
        ),
        stubOpencode({
          continueTurn: (input) =>
            Effect.gen(function* () {
              agentCalls += 1
              continued = input
              yield* Effect.tryPromise({
                try: async () => {
                  await git(root, ["add", "feature.ts"])
                  await git(root, [
                    "commit",
                    "--no-verify",
                    "-m",
                    "feat: add feature\n\nPolicy-fixed body\n\nCloses #2039",
                  ])
                },
                catch: (cause) => cause as Error,
              })
              return {
                sessionId: input.sessionId,
                assistantText: "",
              }
            }).pipe(Effect.orDie),
        }),
      )

      expect(result.completion).toBe("agent_fallback")
      expect(agentCalls).toBe(1)
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_from_implement")
      expect(continued!.cwd).toBe(root)
      expect(continued!.prompt).toContain("commitlint")
      expect(continued!.prompt).toContain("Prefer this exact commit message")
      expect(continued!.prompt).toContain("Bounded native failure diagnostics")
      // Canonical copy updated from the agent-rewritten commit.
      expect(result.publicationTitle).toBe("feat: add feature")
      expect(result.publicationBody).toContain("Policy-fixed body")
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
    }))

  it("does not invoke agent when postcondition is already met", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "already committed\n\nCloses #91",
      ])

      let continued = 0
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "already committed",
            publicationBody: "Seeded.\n\nCloses #91",
          }),
        ),
        stubOpencode({
          continueTurn: () => {
            continued += 1
            return Effect.succeed({
              sessionId: "ses",
              assistantText: "",
            })
          },
        }),
      )

      expect(result.completion).toBe("native")
      expect(continued).toBe(0)
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
    }))

  it("fails when native and fallback both leave the postcondition unmet", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "commit-msg")
      await writeFile(
        hookPath,
        `#!/bin/sh
echo always fail >&2
exit 1
`,
      )
      await chmod(hookPath, 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
            publicationTitle: "feat: always fail",
            publicationBody: "Will not commit.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: () =>
            Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "",
            }),
        }),
      )

      expect(error).toBeInstanceOf(CommitPostconditionError)
      expect((error as CommitPostconditionError).worktreePath).toBe(root)
    }))

  it("requires Session context for copy generation and agent fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: null,
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitSessionContextMissingError)
    }))

  it("maps OpenCode exit failure during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for failure path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                AgentBackendExitError.new({ exitCode: 2, cwd: root }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
      expect((error as CommitOpenCodeError).worktreePath).toBe(root)
      expect((error as CommitOpenCodeError).sessionId).toBe(
        "ses_implement_session",
      )
    }))

  it("maps OpenCode timeout failure during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for timeout path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                new AgentBackendTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for session path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(new AgentBackendSessionIdMissingError({ cwd: root })),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))
})
