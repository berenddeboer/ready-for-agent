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
import type { LifecycleStepContext } from "../src/index.js"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitPostconditionError,
  CommitSessionContextMissingError,
  CommitStartingCommitMissingError,
  CommitWorktreeContextMissingError,
  buildDeterministicCommitMessage,
  commit,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 91,
  issueTitle: "Add widgets endpoint",
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
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
  }) => Effect.Effect<{ sessionId: string }, never>
  readonly continueTurn?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string }, never>
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
    effect.pipe(Effect.provide(opencodeLayer), Effect.provide(PlatformLayer)),
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

describe("buildDeterministicCommitMessage", () => {
  it("includes title and Closes reference", () => {
    expect(
      buildDeterministicCommitMessage({
        githubIssueNumber: 91,
        issueTitle: "Add widgets endpoint",
      }),
    ).toBe("Add widgets endpoint (#91)\n\nCloses #91")
  })

  it("falls back when title is missing", () => {
    expect(
      buildDeterministicCommitMessage({
        githubIssueNumber: 7,
        issueTitle: null,
      }),
    ).toContain("Closes #7")
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

  it("native commit succeeds without Agent Backend invocation", () =>
    withTempRepo(async (root, startingOid) => {
      // Common Commit path: no .ready-for-agent directory yet.
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      let continued = 0
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
            githubIssueNumber: 2039,
            issueTitle: "Fix the widgets path",
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
      expect(continued).toBe(0)

      const count = await git(root, [
        "rev-list",
        "--count",
        `${startingOid}..HEAD`,
      ])
      expect(count).toBe("1")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain("Closes #2039")
      expect(message).toContain("Fix the widgets path")
      expect(await git(root, ["status", "--porcelain"])).toBe("")
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
            githubIssueNumber: 2039,
            issueTitle: "Fix the widgets path",
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
      // Simulate Pre-Commit staging the whole worktree.
      await git(root, ["add", "-A"])

      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            githubIssueNumber: 12,
            issueTitle: "Keep diagnostics out",
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

  it("reuses an existing postcondition without committing again or calling the agent", () =>
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
      expect(continued).toBe(0)
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore)
    }))

  it("falls back to one Agent Turn when the commit-msg hook rejects the message", () =>
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
            githubIssueNumber: 2039,
            issueTitle: "Add feature",
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
              // Agent repairs policy: conventional commit + closes issue.
              yield* Effect.tryPromise({
                try: async () => {
                  await git(root, ["add", "feature.ts"])
                  await git(root, [
                    "commit",
                    "--no-verify",
                    "-m",
                    "feat: add feature\n\nCloses #2039",
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
      expect(continued!.prompt).toContain("closes GitHub issue #2039")
      expect(continued!.prompt).toContain("Bounded native failure diagnostics")
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
    }))

  it("does not invoke agent when native reports failure but the commit already exists", () =>
    withTempRepo(async (root, startingOid) => {
      // Pre-create the implementation commit so postcondition is met after a
      // would-be-native attempt path that first checks postcondition.
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
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: () =>
            // Agent does not create a commit either.
            Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "",
            }),
        }),
      )

      expect(error).toBeInstanceOf(CommitPostconditionError)
      expect((error as CommitPostconditionError).worktreePath).toBe(root)
    }))

  it("requires Session context only for agent fallback", () =>
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
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                new AgentBackendExitError({ exitCode: 2, cwd: root }),
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
