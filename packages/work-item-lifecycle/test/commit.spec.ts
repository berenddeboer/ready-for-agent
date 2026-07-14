import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CommitFailedError,
  CommitInvalidWorktreeContextError,
  CommitWorktreeContextMissingError,
  commit,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (worktreePath: string | null): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 91,
  model: "opencode/test-model",
  variant: "high",
  worktreePath,
  sessionId: "ses_commit",
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

const gitStdout = async (root: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  }
  return stdout.trim()
}

const withTempGit = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-commit-"))
  try {
    await initGitRepo(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

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

  it("creates a commit for staged implementation changes", () =>
    withTempGit(async (root) => {
      await writeFile(join(root, "change.txt"), "implemented\n")
      await run(commit(baseContext(root)))
      const message = await gitStdout(root, "log", "-1", "--pretty=%s")
      expect(message).toBe("Implement #91")
      const subjectFiles = await gitStdout(
        root,
        "show",
        "--name-only",
        "--pretty=format:",
        "HEAD",
      )
      expect(subjectFiles).toContain("change.txt")
    }))

  it("succeeds without creating a commit when the index is empty", () =>
    withTempGit(async (root) => {
      const before = await gitStdout(root, "rev-parse", "HEAD")
      await run(commit(baseContext(root)))
      const after = await gitStdout(root, "rev-parse", "HEAD")
      expect(after).toBe(before)
    }))

  it("is re-entrant after a successful commit", () =>
    withTempGit(async (root) => {
      await writeFile(join(root, "change.txt"), "implemented\n")
      await run(commit(baseContext(root)))
      const first = await gitStdout(root, "rev-parse", "HEAD")
      await run(commit(baseContext(root)))
      const second = await gitStdout(root, "rev-parse", "HEAD")
      expect(second).toBe(first)
    }))

  it("fails when git commit exits non-zero", () =>
    withTempGit(async (root) => {
      await mkdir(join(root, ".git", "hooks"), { recursive: true })
      await writeFile(
        join(root, ".git", "hooks", "commit-msg"),
        "#!/usr/bin/env bash\necho 'commit-msg rejected' >&2\nexit 1\n",
        { mode: 0o755 },
      )
      await writeFile(join(root, "change.txt"), "implemented\n")
      const error = await run(commit(baseContext(root)).pipe(Effect.flip))
      expect(error).toBeInstanceOf(CommitFailedError)
      expect((error as CommitFailedError).worktreePath).toBe(root)
      expect((error as CommitFailedError).exitCode).toBe(1)
      expect((error as CommitFailedError).output).toContain(
        "commit-msg rejected",
      )
    }))
})
