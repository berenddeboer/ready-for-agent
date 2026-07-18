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
        closeIssue: () => Effect.void,
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
        closeIssue: () => Effect.void,
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
            completionSummary: null,
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
        closeIssue: () => Effect.void,
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

  it("routes clean NO_CHANGES through Close Issue and cleanup to Complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-no-change-complete-"))
    const githubCalls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
    }> = []
    let preCommitCalls = 0
    let reviewCalls = 0
    let commitCalls = 0
    let createPrCalls = 0
    let decidePrMergeCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const summary = "Investigated the question; no repository changes."

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_no_change"),
        assessChanges: () =>
          Effect.succeed({
            _tag: "no_changes",
            completionSummary: summary,
          }),
        preCommit: () => {
          preCommitCalls += 1
          return Effect.void
        },
        review: () => {
          reviewCalls += 1
          return Effect.void
        },
        commit: () => {
          commitCalls += 1
          return Effect.void
        },
        createPr: () => {
          createPrCalls += 1
          return Effect.succeed(1)
        },
        watchPrStatusChecks: () => Effect.succeed("succeeded"),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: () => Effect.void,
        decidePrMerge: () => {
          decidePrMergeCalls += 1
          return Effect.succeed({ _tag: "clanker_merge" })
        },
        mergePr: () => Effect.void,
        closeIssue: (context) =>
          Effect.sync(() => {
            githubCalls.push({
              issueNumber: context.githubIssueNumber,
              workItemId: context.workItemId,
              summary: context.completionSummary ?? "",
            })
          }),
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
            githubIssueNumber: 290,
            title: "No change outcome",
            body: "body",
            url: "https://github.com/acme/widgets/issues/290",
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

          const created = yield* lifecycle.implementNow(repository.id, 290)
          yield* claimAndRun // create_worktree
          yield* claimAndRun // install
          yield* claimAndRun // implement

          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag !== "processed") {
            return
          }
          expect(afterAssess.workItem.state).toBe("close_issue")
          expect(afterAssess.workItem.completionSummary).toBe(summary)
          expect(afterAssess.workItem.githubPullRequestNumber).toBeNull()

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(githubCalls).toEqual([
            {
              issueNumber: 290,
              workItemId: created.id,
              summary,
            },
          ])

          const afterCleanup = yield* claimAndRun
          expect(afterCleanup._tag).toBe("processed")
          if (afterCleanup._tag !== "processed") {
            return
          }
          expect(afterCleanup.workItem.state).toBe("complete")
          expect(afterCleanup.workItem.completionSummary).toBe(summary)
          expect(afterCleanup.workItem.githubPullRequestNumber).toBeNull()
          expect(preCommitCalls).toBe(0)
          expect(reviewCalls).toBe(0)
          expect(commitCalls).toBe(0)
          expect(createPrCalls).toBe(0)
          expect(decidePrMergeCalls).toBe(0)
          expect(
            afterCleanup.workItem.stepRuns.map((run) => [run.step, run.status]),
          ).toEqual([
            ["create_worktree", "succeeded"],
            ["install_dependencies", "succeeded"],
            ["implement", "succeeded"],
            ["assess_changes", "succeeded"],
            ["close_issue", "succeeded"],
            ["local_cleanup", "succeeded"],
          ])
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("routes clean CHANGES from OpenCode to Pre-Commit without a second git gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-clean-changes-"))
    let opencodeAssessCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_clean_changes"),
        assessChanges: () => {
          opencodeAssessCalls += 1
          return Effect.succeed({ _tag: "changes" })
        },
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
        closeIssue: () => Effect.die("close issue must not run"),
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
            githubIssueNumber: 291,
            title: "Clean classified as changes",
            body: "body",
            url: "https://github.com/acme/widgets/issues/291",
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

          yield* lifecycle.implementNow(repository.id, 291)
          yield* claimAndRun
          yield* claimAndRun
          yield* claimAndRun
          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag === "processed") {
            expect(afterAssess.workItem.state).toBe("pre_commit")
            expect(afterAssess.workItem.completionSummary).toBeNull()
          }
          expect(opencodeAssessCalls).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps Assess Changes retryable on malformed no-change results without closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-malformed-no-change-"))
    let closeCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_malformed"),
        assessChanges: () =>
          Effect.fail(
            new Error(
              "OpenCode did not report a unique final READY_FOR_AGENT_RESULT",
            ),
          ),
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
        closeIssue: () => {
          closeCalls += 1
          return Effect.void
        },
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
            githubIssueNumber: 292,
            title: "Malformed assess",
            body: "body",
            url: "https://github.com/acme/widgets/issues/292",
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

          yield* lifecycle.implementNow(repository.id, 292)
          yield* claimAndRun
          yield* claimAndRun
          yield* claimAndRun
          const failed = yield* claimAndRun
          expect(failed._tag).toBe("processed")
          if (failed._tag !== "processed") {
            return
          }
          expect(failed.workItem.state).toBe("assess_changes")
          expect(failed.workItem.completionSummary).toBeNull()
          expect(failed.workItem.stepRuns.at(-1)?.status).toBe("failed")
          expect(closeCalls).toBe(0)

          const retried = yield* lifecycle.retry(failed.workItem.id)
          expect(retried.state).toBe("assess_changes")
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("Implement Locally pauses before Close Issue for NO_CHANGES and resumes on Start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-local-no-change-"))
    let closeCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const summary = "Local no-change summary"

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_local_no_change"),
        assessChanges: () =>
          Effect.succeed({
            _tag: "no_changes",
            completionSummary: summary,
          }),
        preCommit: () => Effect.die("pre-commit must not run"),
        review: () => Effect.void,
        commit: () => Effect.die("commit must not run"),
        createPr: () => Effect.succeed(1),
        watchPrStatusChecks: () => Effect.succeed("succeeded"),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: () => Effect.void,
        decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
        mergePr: () => Effect.void,
        closeIssue: () => {
          closeCalls += 1
          return Effect.void
        },
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
            githubIssueNumber: 293,
            title: "Local no change",
            body: "body",
            url: "https://github.com/acme/widgets/issues/293",
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

          const created = yield* lifecycle.implementLocally(repository.id, 293)
          expect(created.pauseBeforeStep).toBe("commit")

          yield* claimAndRun // create
          yield* claimAndRun // install
          yield* claimAndRun // implement
          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag !== "processed") {
            return
          }
          expect(afterAssess.workItem.state).toBe("close_issue")
          expect(afterAssess.workItem.paused).toBe(true)
          expect(afterAssess.workItem.pauseBeforeStep).toBe("close_issue")
          expect(afterAssess.workItem.completionSummary).toBe(summary)
          expect(closeCalls).toBe(0)

          const none = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(none)).toBe(true)

          const started = yield* lifecycle.start(afterAssess.workItem.id)
          expect(started.paused).toBe(false)
          expect(started.state).toBe("close_issue")

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(closeCalls).toBe(1)

          const afterCleanup = yield* claimAndRun
          expect(afterCleanup._tag).toBe("processed")
          if (afterCleanup._tag === "processed") {
            expect(afterCleanup.workItem.state).toBe("complete")
          }
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retries Close Issue and local cleanup after partial failure without reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-close-retry-"))
    let closeAttempts = 0
    let cleanupAttempts = 0
    const githubCalls: string[] = []
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const summary = "Summary for retry path"

      const steps: LifecycleStepsShape = {
        createWorktree: () =>
          Effect.succeed({
            worktreePath: worktree,
            startingCommitOid,
          }),
        installDependencies: () => Effect.void,
        implement: () => Effect.succeed("ses_close_retry"),
        assessChanges: () =>
          Effect.succeed({
            _tag: "no_changes",
            completionSummary: summary,
          }),
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
        closeIssue: (context) =>
          Effect.gen(function* () {
            closeAttempts += 1
            if (closeAttempts === 1) {
              return yield* Effect.fail(new Error("GitHub temporary failure"))
            }
            githubCalls.push(context.completionSummary ?? "")
          }),
        localCleanup: () =>
          Effect.gen(function* () {
            cleanupAttempts += 1
            if (cleanupAttempts === 1) {
              return yield* Effect.fail(new Error("cleanup temporary failure"))
            }
          }),
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
            githubIssueNumber: 294,
            title: "Close retry",
            body: "body",
            url: "https://github.com/acme/widgets/issues/294",
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

          yield* lifecycle.implementNow(repository.id, 294)
          yield* claimAndRun
          yield* claimAndRun
          yield* claimAndRun
          const afterAssess = yield* claimAndRun
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag !== "processed") {
            return
          }
          expect(afterAssess.workItem.state).toBe("close_issue")
          expect(afterAssess.workItem.completionSummary).toBe(summary)

          const failedClose = yield* claimAndRun
          expect(failedClose._tag).toBe("processed")
          if (failedClose._tag !== "processed") {
            return
          }
          expect(failedClose.workItem.state).toBe("close_issue")
          expect(failedClose.workItem.completionSummary).toBe(summary)
          expect(failedClose.workItem.stepRuns.at(-1)?.status).toBe("failed")

          yield* lifecycle.retry(failedClose.workItem.id)
          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(githubCalls).toEqual([summary])

          const failedCleanup = yield* claimAndRun
          expect(failedCleanup._tag).toBe("processed")
          if (failedCleanup._tag !== "processed") {
            return
          }
          expect(failedCleanup.workItem.state).toBe("local_cleanup")
          expect(failedCleanup.workItem.completionSummary).toBe(summary)

          yield* lifecycle.retry(failedCleanup.workItem.id)
          const completed = yield* claimAndRun
          expect(completed._tag).toBe("processed")
          if (completed._tag === "processed") {
            expect(completed.workItem.state).toBe("complete")
            expect(completed.workItem.completionSummary).toBe(summary)
          }
          expect(closeAttempts).toBe(2)
          expect(cleanupAttempts).toBe(2)
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
