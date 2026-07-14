import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  createWorktree,
  makeWorkItemId,
  removeWorktree,
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

describe("removeWorktree", () => {
  it("removes the worktree directory and deletes the Work Item branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const { path, branch } = await run(
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
            worktreePath: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree(context)
          return {
            path: created,
            branch: workItemBranchName({
              githubOwner: "acme",
              githubRepo: "widgets",
              githubIssueNumber: 42,
              workItemId,
            }),
          }
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)

      const branches = await git(bare, ["branch", "--list", branch])
      expect(branches).toBe("")

      const worktrees = await git(bare, ["worktree", "list", "--porcelain"])
      expect(worktrees.includes(path)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("is a no-op when the worktree and branch are already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-absent-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            worktreePath: null,
            sessionId: null,
          })
        }),
      )

      const planned = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      expect(await Bun.file(join(planned, "README.md")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a worktree when only the path is known from context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-path-"))
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

          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            worktreePath: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree({
            ...context,
            worktreePath: created,
          })
          return created
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
