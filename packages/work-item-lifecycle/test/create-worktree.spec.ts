import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  GitCommandError,
  WorktreeConflictError,
  createWorktree,
  makeWorkItemId,
  workItemBranchName,
  workItemWorktreePath,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
  >,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

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

const initBareRepository = async (root: string) => {
  const source = join(root, "source")
  const bare = join(root, "widgets.git")
  await mkdir(source, { recursive: true })
  await git(source, ["init", "-b", "main"])
  await git(source, ["config", "user.email", "test@example.com"])
  await git(source, ["config", "user.name", "Test"])
  await writeFile(join(source, "README.md"), "# widgets\n")
  await git(source, ["add", "README.md"])
  await git(source, ["commit", "-m", "initial"])
  await git(root, ["clone", "--bare", source, bare])
  return bare
}

const initDotBareRepository = async (root: string) => {
  const project = join(root, "monorepo")
  const source = join(root, "source")
  const bare = join(project, ".bare")
  await mkdir(source, { recursive: true })
  await mkdir(project, { recursive: true })
  await git(source, ["init", "-b", "main"])
  await git(source, ["config", "user.email", "test@example.com"])
  await git(source, ["config", "user.name", "Test"])
  await writeFile(join(source, "README.md"), "# monorepo\n")
  await git(source, ["add", "README.md"])
  await git(source, ["commit", "-m", "initial"])
  await git(root, ["clone", "--bare", source, bare])
  return bare
}

const initDotBareWrapper = async (root: string) => {
  const bare = await initDotBareRepository(root)
  const project = join(root, "monorepo")
  await writeFile(join(project, ".git"), "gitdir: ./.bare\n")
  return { bare, project }
}

const initNonBareRepository = async (root: string) => {
  const repo = join(root, "widgets")
  await mkdir(repo, { recursive: true })
  await git(repo, ["init", "-b", "main"])
  await git(repo, ["config", "user.email", "test@example.com"])
  await git(repo, ["config", "user.name", "Test"])
  await writeFile(join(repo, "README.md"), "# widgets\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-m", "initial"])
  return repo
}

describe("createWorktree", () => {
  it("creates a worktree and branch for a bare Repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-bare-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return (yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          })).worktreePath
        }),
      )

      const expected = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      expect(path).toBe(expected)

      const branch = workItemBranchName({
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      const checkedOut = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])
      expect(checkedOut).toBe(branch)
      expect(await Bun.file(join(path, "README.md")).text()).toContain(
        "widgets",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("starts from origin's default branch tip when that branch is not main", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-trunk-"))
    try {
      const source = join(root, "source")
      const bare = join(root, "widgets.git")
      await mkdir(source, { recursive: true })
      await git(source, ["init", "-b", "trunk"])
      await git(source, ["config", "user.email", "test@example.com"])
      await git(source, ["config", "user.name", "Test"])
      await writeFile(join(source, "README.md"), "# stale-local\n")
      await git(source, ["add", "README.md"])
      await git(source, ["commit", "-m", "initial on trunk"])
      await git(root, ["clone", "--bare", source, bare])

      await writeFile(join(source, "README.md"), "# trunk-default\n")
      await git(source, ["add", "README.md"])
      await git(source, ["commit", "-m", "remote tip on trunk"])

      const workItemId = makeWorkItemId()
      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return (yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 99,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          })).worktreePath
        }),
      )

      expect(await Bun.file(join(path, "README.md")).text()).toContain(
        "trunk-default",
      )
      const tip = await git(path, ["rev-parse", "HEAD"])
      const originTrunk = await git(bare, [
        "rev-parse",
        "refs/remotes/origin/trunk",
      ])
      expect(tip).toBe(originTrunk)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("places dot-bare worktrees in the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-dotbare-"))
    try {
      const bare = await initDotBareRepository(root)
      const workItemId = makeWorkItemId()

      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "pf",
            githubRepo: "monorepo",
            localPath: bare,
            isBare: true,
          })

          return (yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 2039,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          })).worktreePath
        }),
      )

      expect(path).toBe(
        workItemWorktreePath({
          localPath: bare,
          isBare: true,
          githubOwner: "pf",
          githubRepo: "monorepo",
          githubIssueNumber: 2039,
          workItemId,
        }),
      )
      expect(path.startsWith(join(root, "monorepo"))).toBe(true)
      expect(path.includes("/.bare/")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves a dot-bare Git directory from its project wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-dotbare-wrapper-"))
    try {
      const { bare, project } = await initDotBareWrapper(root)
      const workItemId = makeWorkItemId()

      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "processfocus",
            githubRepo: "monorepo",
            localPath: project,
            isBare: true,
          })

          return (yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 2039,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          })).worktreePath
        }),
      )

      expect(path).toBe(
        workItemWorktreePath({
          localPath: bare,
          isBare: true,
          githubOwner: "processfocus",
          githubRepo: "monorepo",
          githubIssueNumber: 2039,
          workItemId,
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("creates a worktree for a non-bare Repository under tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-normal-"))
    const tmpDir = await mkdtemp(join(tmpdir(), "rfa-wt-tmp-"))
    try {
      const repo = await initNonBareRepository(root)
      const workItemId = makeWorkItemId()

      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: repo,
            isBare: false,
          })

          return (yield* createWorktree(
            {
              workItemId,
              repositoryId: repository.id,
              githubIssueNumber: 7,
              model: "opencode/test",
              variant: "low",
              reviewModel: "opencode/test",
              reviewVariant: "low",
              worktreePath: null,
              startingCommitOid: null,
              sessionId: null,
            },
            { tmpDir },
          )).worktreePath
        }),
      )

      expect(path).toBe(
        workItemWorktreePath({
          localPath: repo,
          isBare: false,
          githubOwner: "acme",
          githubRepo: "widgets",
          githubIssueNumber: 7,
          workItemId,
          tmpDir,
        }),
      )
      expect(path.startsWith(tmpDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("converges on the existing correctly configured worktree on re-entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-reentry-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const first = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          const again = yield* createWorktree(context)
          return { created, again }
        }),
      )

      expect(first.again.worktreePath).toBe(first.created.worktreePath)
      expect(first.again.startingCommitOid).toBe(
        first.created.startingCommitOid,
      )
      expect(first.created.startingCommitOid).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails when the planned path exists but is not this Work Item worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-conflict-path-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      const planned = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      await mkdir(planned, { recursive: true })
      await writeFile(join(planned, "hijack.txt"), "nope")

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          }).pipe(Effect.flip)
        }),
      )

      expect(error).toBeInstanceOf(WorktreeConflictError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails when the branch exists without the matching worktree path", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-conflict-branch-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      const branch = workItemBranchName({
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      await git(bare, ["branch", branch, "HEAD"])

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          }).pipe(Effect.flip)
        }),
      )

      expect(error).toBeInstanceOf(WorktreeConflictError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("maps git command failures with command and stderr context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-wt-gitfail-"))
    try {
      const emptyBare = join(root, "empty.git")
      await git(root, ["init", "--bare", emptyBare])
      const workItemId = makeWorkItemId()

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: emptyBare,
            isBare: true,
          })

          return yield* createWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 1,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            startingCommitOid: null,
            sessionId: null,
          }).pipe(Effect.flip)
        }),
      )

      expect(error).toBeInstanceOf(GitCommandError)
      if (error instanceof GitCommandError) {
        expect(error.command).toBe("git")
        expect(error.args.length).toBeGreaterThan(0)
        expect(error.message.length).toBeGreaterThan(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
