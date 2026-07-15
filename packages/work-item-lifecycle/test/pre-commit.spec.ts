import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Layer } from "effect"
import {
  Opencode,
  OpencodeExitError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "../src/index.js"
import {
  HOOK_OUTPUT_PROMPT_LIMIT,
  PreCommitInvalidWorktreeContextError,
  PreCommitOpenCodeError,
  PreCommitSessionContextMissingError,
  PreCommitWorktreeContextMissingError,
  makeWorkItemId,
  preCommit,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 90,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  sessionId: "ses_pre_commit",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly start?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continue?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
}) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: (input) =>
        impl.start?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continue: (input) =>
        impl.continue?.(input) ??
        Effect.succeed({
          sessionId: "ses_pre_commit_default",
          assistantText: "",
        }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, Opencode>,
  opencodeLayer: Layer.Layer<Opencode, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(opencodeLayer), Effect.provide(PlatformLayer)),
  )

const initGitRepo = async (root: string) => {
  const runGit = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
    }
  }
  await runGit("init")
  await runGit("config", "user.email", "test@example.com")
  await runGit("config", "user.name", "Test")
  await runGit("commit", "--allow-empty", "-m", "init")
}

const withTempGit = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-pre-commit-"))
  try {
    await initGitRepo(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeHook = async (root: string, body: string) => {
  await mkdir(join(root, ".git", "hooks"), { recursive: true })
  await writeFile(join(root, ".git", "hooks", "pre-commit"), body, {
    mode: 0o755,
  })
}

describe("preCommit", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(preCommit(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(PreCommitWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-pre-commit-missing-worktree")
    const error = await run(preCommit(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(PreCommitInvalidWorktreeContextError)
  })

  it("rejects missing Session context", () =>
    withTempGit(async (root) => {
      const error = await run(
        preCommit(baseContext(root, { sessionId: null })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(PreCommitSessionContextMissingError)
    }))

  it("succeeds when the pre-commit hook is missing without calling OpenCode", () =>
    withTempGit(async (root) => {
      let continues = 0
      await writeFile(join(root, "change.txt"), "hello\n")
      await run(
        preCommit(baseContext(root)),
        stubOpencode({
          continue: () => {
            continues += 1
            return Effect.succeed({
              sessionId: "ses_unused",
              assistantText: "",
            })
          },
        }),
      )
      expect(continues).toBe(0)
    }))

  it("succeeds when the pre-commit hook exits 0 without calling OpenCode", () =>
    withTempGit(async (root) => {
      let continues = 0
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "hello\n")
      await run(
        preCommit(baseContext(root)),
        stubOpencode({
          continue: () => {
            continues += 1
            return Effect.succeed({
              sessionId: "ses_unused",
              assistantText: "",
            })
          },
        }),
      )
      expect(continues).toBe(0)
    }))

  it("asks OpenCode to fix then re-runs until the hook succeeds", () =>
    withTempGit(async (root) => {
      const diagnostic = "format failed: needs fix"
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ -f ".pre-commit-fixed" ]; then',
          "  exit 0",
          "fi",
          `printf '%s\\n' '${diagnostic}' >&2`,
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "hello\n")

      const prompts: string[] = []
      await run(
        preCommit(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            prompts.push(input.prompt)
            expect(input.sessionId).toBe("ses_pre_commit")
            expect(input.cwd).toBe(root)
            expect(input.model).toBe("opencode/test-model")
            expect(input.variant).toBe("high")
            return Effect.promise(async () => {
              await writeFile(join(root, ".pre-commit-fixed"), "ok\n")
              return {
                sessionId: input.sessionId,
                assistantText: "fixed",
              }
            })
          },
        }),
      )

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain(diagnostic)
      expect(prompts[0]).toContain("pre-commit")
      expect(prompts[0]).toMatch(/fix|Diagnose/i)
      expect(prompts[0]).toMatch(/Full hook output is at: /)
    }))

  it("writes oversized hook output to a log and only embeds a truncated tail in the prompt", () =>
    withTempGit(async (root) => {
      const head = "HEAD_MARKER_SHOULD_NOT_BE_IN_PROMPT"
      const tail = "TAIL_MARKER_MUST_BE_IN_PROMPT"
      const filler = "x".repeat(HOOK_OUTPUT_PROMPT_LIMIT + 5_000)
      const diagnostic = `${head}\n${filler}\n${tail}`
      await writeFile(join(root, ".hook-diagnostic"), diagnostic)
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ -f ".pre-commit-fixed" ]; then',
          "  exit 0",
          "fi",
          'cat ".hook-diagnostic" >&2',
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "hello\n")

      let prompt = ""
      let logPath = ""
      let logContents = ""
      let logMode = 0
      await run(
        preCommit(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            prompt = input.prompt
            const match = input.prompt.match(/Full hook output is at: (.+)$/m)
            logPath = match?.[1]?.trim() ?? ""
            return Effect.promise(async () => {
              logContents = await readFile(logPath, "utf8")
              logMode = (await stat(logPath)).mode & 0o777
              await writeFile(join(root, ".pre-commit-fixed"), "ok\n")
              return {
                sessionId: input.sessionId,
                assistantText: "fixed",
              }
            })
          },
        }),
      )

      expect(prompt.length).toBeLessThan(HOOK_OUTPUT_PROMPT_LIMIT + 2_000)
      expect(prompt).not.toContain(head)
      expect(prompt).toContain(tail)
      expect(logPath.length).toBeGreaterThan(0)
      expect(logContents).toContain(head)
      expect(logContents).toContain(tail)
      expect(logMode).toBe(0o600)
      await expect(access(logPath)).rejects.toThrow()
    }))

  it("asks OpenCode again when the hook still fails after a fix attempt", () =>
    withTempGit(async (root) => {
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'attempts_file=".pre-commit-attempts"',
          "n=0",
          'if [ -f "$attempts_file" ]; then',
          '  n=$(cat "$attempts_file")',
          "fi",
          "n=$((n + 1))",
          'printf "%s" "$n" > "$attempts_file"',
          'if [ "$n" -ge 3 ]; then',
          "  exit 0",
          "fi",
          'printf "still failing attempt %s\\n" "$n" >&2',
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "hello\n")

      let continues = 0
      await run(
        preCommit(baseContext(root)),
        stubOpencode({
          continue: () => {
            continues += 1
            return Effect.succeed({
              sessionId: "ses_pre_commit",
              assistantText: "",
            })
          },
        }),
      )
      // Hook fails on attempts 1 and 2, succeeds on 3 → two OpenCode fixes.
      expect(continues).toBe(2)
    }))

  it("fails with OpenCode error when fix continue fails", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\necho boom >&2\nexit 1\n")
      await writeFile(join(root, "change.txt"), "hello\n")
      const error = await run(
        preCommit(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.fail(
              new OpencodeExitError({
                exitCode: 2,
                cwd: root,
                sessionId: "ses_pre_commit",
              }),
            ),
        }),
      )
      expect(error).toBeInstanceOf(PreCommitOpenCodeError)
      expect((error as PreCommitOpenCodeError).sessionId).toBe("ses_pre_commit")
      expect((error as PreCommitOpenCodeError).worktreePath).toBe(root)
    }))

  it("maps OpenCode timeout and missing session to PreCommitOpenCodeError", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 1\n")
      await writeFile(join(root, "change.txt"), "hello\n")

      for (const cause of [
        new OpencodeTimeoutError({
          cwd: root,
          timeoutMs: 1,
          sessionId: "ses_pre_commit",
        }),
        new SessionIdNotFoundError({ cwd: root }),
      ]) {
        const error = await run(
          preCommit(baseContext(root)).pipe(Effect.flip),
          stubOpencode({
            continue: () => Effect.fail(cause),
          }),
        )
        expect(error).toBeInstanceOf(PreCommitOpenCodeError)
      }
    }))

  it("stages untracked files before running the hook", () =>
    withTempGit(async (root) => {
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if ! git diff --cached --name-only | grep -qx "change.txt"; then',
          '  echo "change.txt not staged" >&2',
          "  exit 2",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "staged-by-pre-commit\n")
      await run(preCommit(baseContext(root)))
    }))
})
