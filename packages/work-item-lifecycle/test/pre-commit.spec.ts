import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import type { LifecycleStepContext } from "../src/index.js"
import {
  PreCommitHookFailedError,
  PreCommitInvalidWorktreeContextError,
  PreCommitWorktreeContextMissingError,
  makeWorkItemId,
  preCommit,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (worktreePath: string | null): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 90,
  model: "opencode/test-model",
  variant: "high",
  worktreePath,
  sessionId: "ses_pre_commit",
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof PlatformLayer>>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(PlatformLayer)))

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

  it("succeeds when the pre-commit hook is missing", () =>
    withTempGit(async (root) => {
      await writeFile(join(root, "change.txt"), "hello\n")
      await run(preCommit(baseContext(root)))
    }))

  it("succeeds when the pre-commit hook exits 0", () =>
    withTempGit(async (root) => {
      await mkdir(join(root, ".git", "hooks"), { recursive: true })
      await writeFile(
        join(root, ".git", "hooks", "pre-commit"),
        "#!/usr/bin/env bash\nexit 0\n",
        { mode: 0o755 },
      )
      await writeFile(join(root, "change.txt"), "hello\n")
      await run(preCommit(baseContext(root)))
    }))

  it("fails when the pre-commit hook exits non-zero", () =>
    withTempGit(async (root) => {
      const diagnostic = `format failed: ${"x".repeat(9_000)}`
      await mkdir(join(root, ".git", "hooks"), { recursive: true })
      await writeFile(
        join(root, ".git", "hooks", "pre-commit"),
        `#!/usr/bin/env bash\nprintf '%s\\n' '${diagnostic}' >&2\nexit 1\n`,
        { mode: 0o755 },
      )
      await writeFile(join(root, "change.txt"), "hello\n")
      const error = await run(preCommit(baseContext(root)).pipe(Effect.flip))
      expect(error).toBeInstanceOf(PreCommitHookFailedError)
      expect((error as PreCommitHookFailedError).exitCode).toBe(1)
      expect((error as PreCommitHookFailedError).output).toBe(diagnostic)
      expect((error as PreCommitHookFailedError).worktreePath).toBe(root)
    }))

  it("stages untracked files before running the hook", () =>
    withTempGit(async (root) => {
      await mkdir(join(root, ".git", "hooks"), { recursive: true })
      await writeFile(
        join(root, ".git", "hooks", "pre-commit"),
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
        { mode: 0o755 },
      )
      await writeFile(join(root, "change.txt"), "staged-by-pre-commit\n")
      await run(preCommit(baseContext(root)))
    }))
})
