import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  assessChanges,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

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

const initWorktreeRepo = async (root: string) => {
  const worktree = join(root, "worktree")
  await mkdir(worktree, { recursive: true })
  await git(worktree, ["init"])
  await git(worktree, ["config", "user.email", "test@example.com"])
  await git(worktree, ["config", "user.name", "Test"])
  await writeFile(join(worktree, "README.md"), "# widgets\n")
  await git(worktree, ["add", "README.md"])
  await git(worktree, ["commit", "-m", "initial"])
  const startingCommitOid = await git(worktree, ["rev-parse", "HEAD"])
  return { worktree, startingCommitOid }
}

describe("Assess Changes lifecycle routes", () => {
  it("routes dirty worktrees to Pre-Commit without continuing OpenCode", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-assess-lifecycle-"))
    let opencodeCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => {
          opencodeCalls += 1
          return Effect.succeed("ses_assess_lifecycle")
        },
        assessChanges: (context) =>
          assessChanges(context).pipe(Effect.provide(PlatformLayer)),
        preCommit: () => {
          opencodeCalls += 1
          return Effect.void
        },
        review: () => Effect.void,
        commit: () => Effect.void,
        createPr: () => Effect.succeed(1),
        watchPrStatusChecks: () => Effect.succeed("succeeded"),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: () => Effect.void,
        decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
        mergePr: () => Effect.void,
        localCleanup: () => Effect.void,
        removeWorktree: () => Effect.void,
      }

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
        ),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(DatabaseTest),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const db = yield* DbService

          yield* db.updateConfig({
            defaultModel: "opencode/test",
            defaultVariant: "low",
            reviewModel: null,
            reviewVariant: null,
            maxConcurrentOpencodeSessions: 2,
            maxConcurrentWorkItems: 5,
          })

          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: worktree,
            isBare: false,
          })
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 283,
            title: "Assess changes",
            body: "body",
            url: "https://github.com/acme/widgets/issues/283",
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            parent: null,
            parentPosition: null,
            hasChildren: false,
            blockedBy: [],
          })

          const claimAndRun = Effect.gen(function* () {
            const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(claimed)).toBe(true)
            if (Option.isNone(claimed)) {
              return yield* Effect.die("expected lifecycle job")
            }
            return yield* lifecycle.runStep(
              (claimed.value.payload as { stepRunId: string }).stepRunId,
            )
          })

          yield* lifecycle.implementNow(repository.id, 283)

          const afterCreate = yield* claimAndRun
          expect(afterCreate._tag).toBe("processed")
          if (afterCreate._tag !== "processed") {
            return
          }
          expect(afterCreate.workItem.startingCommitOid).toBe(startingCommitOid)
          expect(afterCreate.workItem.worktreePath).toBe(worktree)

          yield* claimAndRun
          const afterImplement = yield* claimAndRun
          expect(afterImplement._tag).toBe("processed")
          if (afterImplement._tag !== "processed") {
            return
          }
          expect(afterImplement.workItem.state).toBe("assess_changes")

          yield* Effect.promise(() =>
            writeFile(join(worktree, "change.txt"), "dirty\n"),
          )

          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag !== "processed") {
            return
          }
          expect(afterAssess.workItem.state).toBe("pre_commit")
          expect(afterAssess.workItem.startingCommitOid).toBe(startingCommitOid)
          expect(
            afterAssess.workItem.stepRuns.filter(
              (run) => run.step === "assess_changes",
            ),
          ).toEqual([
            expect.objectContaining({
              step: "assess_changes",
              status: "succeeded",
            }),
          ])
          expect(opencodeCalls).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("routes commits after the starting OID to Pre-Commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-assess-commits-"))
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      await writeFile(join(worktree, "README.md"), "# later\n")
      await git(worktree, ["add", "README.md"])
      await git(worktree, ["commit", "-m", "after start"])

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_assess_commits"),
        assessChanges: (context) =>
          assessChanges(context).pipe(Effect.provide(PlatformLayer)),
        preCommit: () => Effect.void,
        review: () => Effect.void,
        commit: () => Effect.void,
        createPr: () => Effect.succeed(1),
        watchPrStatusChecks: () => Effect.succeed("succeeded"),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: () => Effect.void,
        decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
        mergePr: () => Effect.void,
        localCleanup: () => Effect.void,
        removeWorktree: () => Effect.void,
      }

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
        ),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(DatabaseTest),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const db = yield* DbService

          yield* db.updateConfig({
            defaultModel: "opencode/test",
            defaultVariant: "low",
            reviewModel: null,
            reviewVariant: null,
            maxConcurrentOpencodeSessions: 2,
            maxConcurrentWorkItems: 5,
          })

          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: worktree,
            isBare: false,
          })
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 284,
            title: "Commits after start",
            body: "body",
            url: "https://github.com/acme/widgets/issues/284",
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            parent: null,
            parentPosition: null,
            hasChildren: false,
            blockedBy: [],
          })

          const claimAndRun = Effect.gen(function* () {
            const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(claimed)).toBe(true)
            if (Option.isNone(claimed)) {
              return yield* Effect.die("expected lifecycle job")
            }
            return yield* lifecycle.runStep(
              (claimed.value.payload as { stepRunId: string }).stepRunId,
            )
          })

          yield* lifecycle.implementNow(repository.id, 284)
          yield* claimAndRun
          yield* claimAndRun
          yield* claimAndRun
          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag === "processed") {
            expect(afterAssess.workItem.state).toBe("pre_commit")
          }
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails Assess Changes on git inspection failure and remains retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-assess-retry-"))
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_assess_retry"),
        assessChanges: (context) =>
          assessChanges({
            ...context,
            startingCommitOid: "0".repeat(40),
          }).pipe(Effect.provide(PlatformLayer)),
        preCommit: () => Effect.die("pre-commit must not run"),
        review: () => Effect.void,
        commit: () => Effect.void,
        createPr: () => Effect.succeed(1),
        watchPrStatusChecks: () => Effect.succeed("succeeded"),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: () => Effect.void,
        decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
        mergePr: () => Effect.void,
        localCleanup: () => Effect.void,
        removeWorktree: () => Effect.void,
      }

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
        ),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(DatabaseTest),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const db = yield* DbService

          yield* db.updateConfig({
            defaultModel: "opencode/test",
            defaultVariant: "low",
            reviewModel: null,
            reviewVariant: null,
            maxConcurrentOpencodeSessions: 2,
            maxConcurrentWorkItems: 5,
          })

          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: worktree,
            isBare: false,
          })
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 285,
            title: "Assess retry",
            body: "body",
            url: "https://github.com/acme/widgets/issues/285",
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            parent: null,
            parentPosition: null,
            hasChildren: false,
            blockedBy: [],
          })

          const claimAndRun = Effect.gen(function* () {
            const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(claimed)).toBe(true)
            if (Option.isNone(claimed)) {
              return yield* Effect.die("expected lifecycle job")
            }
            return yield* lifecycle.runStep(
              (claimed.value.payload as { stepRunId: string }).stepRunId,
            )
          })

          yield* lifecycle.implementNow(repository.id, 285)
          yield* claimAndRun
          yield* claimAndRun
          yield* claimAndRun

          const failedAssess = yield* claimAndRun
          expect(failedAssess._tag).toBe("processed")
          if (failedAssess._tag !== "processed") {
            return
          }
          expect(failedAssess.workItem.state).toBe("assess_changes")
          expect(failedAssess.workItem.stepRuns.at(-1)?.status).toBe("failed")

          const retried = yield* lifecycle.retry(failedAssess.workItem.id)
          expect(retried.state).toBe("assess_changes")
          expect(retried.stepRuns.at(-1)?.status).toBe("queued")
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
