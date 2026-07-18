import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import type { LifecycleStepContext } from "../src/index.js"
import {
  AssessChangesInvalidWorktreeContextError,
  AssessChangesNoObservableChangeError,
  AssessChangesStartingCommitMissingError,
  AssessChangesWorktreeContextMissingError,
  GitCommandError,
  assessChanges,
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
  githubIssueNumber: 283,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  startingCommitOid: "placeholder",
  sessionId: "ses_implement",
  ...overrides,
})

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(PlatformLayer)))

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["git", ...args], {
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

const initRepo = async (root: string) => {
  await git(root, ["init"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test"])
  await writeFile(join(root, "README.md"), "# start\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "-m", "initial"])
  return git(root, ["rev-parse", "HEAD"])
}

const withTempGit = async (
  assert: (root: string, startingOid: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-assess-changes-"))
  try {
    const startingOid = await initRepo(root)
    await assert(root, startingOid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("assessChanges", () => {
  it("fails when worktree path is missing", async () => {
    const error = await run(assessChanges(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(AssessChangesWorktreeContextMissingError)
  })

  it("fails when worktree path does not exist", async () => {
    const missing = join(tmpdir(), "rfa-assess-missing-path")
    const error = await run(
      assessChanges(baseContext(missing)).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AssessChangesInvalidWorktreeContextError)
  })

  it("fails when starting commit OID is missing", async () => {
    await withTempGit(async (root) => {
      const error = await run(
        assessChanges(baseContext(root, { startingCommitOid: null })).pipe(
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(AssessChangesStartingCommitMissingError)
    })
  })

  it("routes unstaged changes to success", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "README.md"), "# dirty\n")
      await run(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
      )
    })
  })

  it("routes staged changes to success", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "staged.txt"), "staged\n")
      await git(root, ["add", "staged.txt"])
      await run(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
      )
    })
  })

  it("routes untracked files to success", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "untracked.txt"), "new\n")
      await run(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
      )
    })
  })

  it("routes commits after the starting OID to success", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "README.md"), "# committed\n")
      await git(root, ["add", "README.md"])
      await git(root, ["commit", "-m", "after start"])
      await run(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
      )
    })
  })

  it("fails with no-observable-change when clean at starting OID", async () => {
    await withTempGit(async (root, startingOid) => {
      const error = await run(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AssessChangesNoObservableChangeError)
    })
  })

  it("fails with GitCommandError when starting OID is not in the repository", async () => {
    await withTempGit(async (root) => {
      const error = await run(
        assessChanges(
          baseContext(root, {
            startingCommitOid: "0".repeat(40),
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(GitCommandError)
    })
  })

  it("fails when worktree path is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-assess-file-"))
    try {
      const filePath = join(root, "not-a-dir")
      await writeFile(filePath, "x")
      const error = await run(
        assessChanges(baseContext(filePath)).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AssessChangesInvalidWorktreeContextError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
