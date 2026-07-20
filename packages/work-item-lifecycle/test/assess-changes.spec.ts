import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "../src/index.js"
import {
  AssessChangesInvalidWorktreeContextError,
  AssessChangesResultError,
  AssessChangesSessionMissingError,
  AssessChangesStartingCommitMissingError,
  AssessChangesWorktreeContextMissingError,
  GitCommandError,
  assessChanges,
  makeWorkItemId,
  parseAssessChangesResult,
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
  completionSummary: null,
  sessionId: "ses_implement",
  ...overrides,
})

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect)

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

const initRepo = async (root: string) => {
  await git(root, ["init"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test"])
  await writeFile(join(root, "README.md"), "# start\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "--no-verify", "-m", "initial"])
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

const opencodeLayer = (assistantText: string) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: () => Effect.die("unused"),
      continue: () =>
        Effect.succeed({
          sessionId: "ses_implement",
          assistantText,
        }),
      listModels: () => Effect.succeed([]),
    }),
  )

const runWithOpencode = <A, E>(
  effect: Effect.Effect<A, E, Opencode>,
  assistantText: string,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer(assistantText)),
      Effect.provide(PlatformLayer),
    ),
  )

describe("parseAssessChangesResult", () => {
  it("parses CHANGES as the unique final marker", () => {
    expect(parseAssessChangesResult("READY_FOR_AGENT_RESULT: CHANGES")).toEqual(
      { _tag: "changes" },
    )
  })

  it("parses NO_CHANGES with a preceding summary", () => {
    expect(
      parseAssessChangesResult(
        "Findings are complete.\n\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
      ),
    ).toEqual({
      _tag: "no_changes",
      completionSummary: "Findings are complete.",
    })
  })

  it("rejects blank NO_CHANGES summaries", () => {
    expect(
      parseAssessChangesResult("READY_FOR_AGENT_RESULT: NO_CHANGES"),
    ).toBeNull()
  })

  it("rejects missing, duplicate, or non-final markers", () => {
    expect(parseAssessChangesResult("no result line")).toBeNull()
    expect(
      parseAssessChangesResult(
        [
          "READY_FOR_AGENT_RESULT: CHANGES",
          "READY_FOR_AGENT_RESULT: NO_CHANGES",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseAssessChangesResult(
        "READY_FOR_AGENT_RESULT: CHANGES\nAdditional output",
      ),
    ).toBeNull()
  })
})

describe("assessChanges", () => {
  it("fails when worktree path is missing", async () => {
    const error = await run(
      assessChanges(baseContext(null)).pipe(
        Effect.provide(PlatformLayer),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(AssessChangesWorktreeContextMissingError)
  })

  it("fails when worktree path does not exist", async () => {
    const missing = join(tmpdir(), "rfa-assess-missing-path")
    const error = await run(
      assessChanges(baseContext(missing)).pipe(
        Effect.provide(PlatformLayer),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(AssessChangesInvalidWorktreeContextError)
  })

  it("fails when starting commit OID is missing", async () => {
    await withTempGit(async (root) => {
      const error = await run(
        assessChanges(baseContext(root, { startingCommitOid: null })).pipe(
          Effect.provide(PlatformLayer),
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(AssessChangesStartingCommitMissingError)
    })
  })

  it("routes unstaged changes to CHANGES without OpenCode", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "README.md"), "# dirty\n")
      const result = await run(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.provide(PlatformLayer)),
      )
      expect(result).toEqual({ _tag: "changes" })
    })
  })

  it("routes staged changes to CHANGES", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "staged.txt"), "staged\n")
      await git(root, ["add", "staged.txt"])
      const result = await run(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.provide(PlatformLayer)),
      )
      expect(result).toEqual({ _tag: "changes" })
    })
  })

  it("routes untracked files to CHANGES", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "untracked.txt"), "new\n")
      const result = await run(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.provide(PlatformLayer)),
      )
      expect(result).toEqual({ _tag: "changes" })
    })
  })

  it("routes commits after the starting OID to CHANGES", async () => {
    await withTempGit(async (root, startingOid) => {
      await writeFile(join(root, "README.md"), "# committed\n")
      await git(root, ["add", "README.md"])
      await git(root, ["commit", "--no-verify", "-m", "after start"])
      const result = await run(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.provide(PlatformLayer)),
      )
      expect(result).toEqual({ _tag: "changes" })
    })
  })

  it("confirms clean worktree NO_CHANGES via OpenCode", async () => {
    await withTempGit(async (root, startingOid) => {
      const result = await runWithOpencode(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
        "Investigated without edits.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
      )
      expect(result).toEqual({
        _tag: "no_changes",
        completionSummary: "Investigated without edits.",
      })
    })
  })

  it("trusts clean worktree CHANGES classification from OpenCode", async () => {
    await withTempGit(async (root, startingOid) => {
      const result = await runWithOpencode(
        assessChanges(baseContext(root, { startingCommitOid: startingOid })),
        "READY_FOR_AGENT_RESULT: CHANGES",
      )
      expect(result).toEqual({ _tag: "changes" })
    })
  })

  it("fails when session is missing for clean worktree confirmation", async () => {
    await withTempGit(async (root, startingOid) => {
      const error = await run(
        assessChanges(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: null,
          }),
        ).pipe(Effect.provide(PlatformLayer), Effect.flip),
      )
      expect(error).toBeInstanceOf(AssessChangesSessionMissingError)
    })
  })

  it("fails retryably on malformed OpenCode results", async () => {
    await withTempGit(async (root, startingOid) => {
      const error = await runWithOpencode(
        assessChanges(
          baseContext(root, { startingCommitOid: startingOid }),
        ).pipe(Effect.flip),
        "READY_FOR_AGENT_RESULT: NO_CHANGES",
      )
      expect(error).toBeInstanceOf(AssessChangesResultError)
    })
  })

  it("fails with GitCommandError when starting OID is not in the repository", async () => {
    await withTempGit(async (root) => {
      const error = await run(
        assessChanges(
          baseContext(root, {
            startingCommitOid: "0".repeat(40),
          }),
        ).pipe(Effect.provide(PlatformLayer), Effect.flip),
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
        assessChanges(baseContext(filePath)).pipe(
          Effect.provide(PlatformLayer),
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(AssessChangesInvalidWorktreeContextError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
