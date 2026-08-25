import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  CommitNoChangeConfirmationError,
  LifecycleStepFailedError,
  LifecycleSteps,
  type LifecycleStepsShape,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

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

const initWorktreeRepo = async (root: string) => {
  const worktree = join(root, "worktree")
  await mkdir(worktree, { recursive: true })
  await git(worktree, ["init"])
  await git(worktree, ["config", "user.email", "test@example.com"])
  await git(worktree, ["config", "user.name", "Test"])
  await writeFile(join(worktree, "README.md"), "# widgets\n")
  await git(worktree, ["add", "README.md"])
  await git(worktree, ["commit", "--no-verify", "-m", "initial"])
  const startingCommitOid = await git(worktree, ["rev-parse", "HEAD"])
  return { worktree, startingCommitOid }
}

const committed = {
  _tag: "committed" as const,
  completion: "native" as const,
  publicationTitle: "feat: test",
  publicationBody: "Why\n\nCloses #1",
}

const prLaneMustNotRun = {
  createPr: () => Effect.die("create PR must not run for late No-Change"),
  watchPrStatusChecks: () =>
    Effect.die("status checks must not run for late No-Change"),
  resolvePrMergeConflict: () =>
    Effect.die("merge conflict must not run for late No-Change"),
  investigatePrStatusChecks: () =>
    Effect.die("investigate checks must not run for late No-Change"),
  markPrReadyForReview: () =>
    Effect.die("mark ready must not run for late No-Change"),
  decidePrMerge: () =>
    Effect.die("decide merge must not run for late No-Change"),
  mergePr: () => Effect.die("merge PR must not run for late No-Change"),
}

const baseSteps = (input: {
  readonly worktree: string
  readonly startingCommitOid: string
  readonly overrides: Partial<LifecycleStepsShape>
}): LifecycleStepsShape => ({
  createWorktree: () =>
    Effect.succeed({
      worktreePath: input.worktree,
      startingCommitOid: input.startingCommitOid,
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_late_no_change"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () => Effect.succeed(committed),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 1,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded" as const,
      createdAt: new Date(0),
      headSha: "settled-head",
      headPushedAt: new Date(0),
      isDraft: true,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
  ...input.overrides,
})

const lifecycleLayer = (steps: LifecycleStepsShape) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const seedConfigAndIssue = (input: {
  readonly worktree: string
  readonly issueNumber: number
  readonly title: string
}) =>
  Effect.gen(function* () {
    const db = yield* DbService
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: "opencode/test",
      defaultThinkingLevel: "low",
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath: input.worktree,
      isBare: false,
    })
    yield* db.storeIssue({
      repositoryId: repository.id,
      issueNumber: input.issueNumber,
      title: input.title,
      body: "body",
      url: `https://github.com/acme/widgets/issues/${input.issueNumber}`,
      state: "OPEN",
      githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
      issueAuthor: null,
      parent: null,
      parentPosition: null,
      hasChildren: false,
      blockedBy: [],
    })
    return repository
  })

const claimAndRun = Effect.gen(function* () {
  const lifecycle = yield* WorkItemLifecycle
  const queue = yield* QueueService
  const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
  expect(Option.isSome(claimed)).toBe(true)
  if (Option.isNone(claimed)) {
    return yield* Effect.die("expected lifecycle job")
  }
  return yield* lifecycle.runStep(
    (claimed.value.payload as { stepRunId: string }).stepRunId,
  )
})

const runThroughReview = Effect.gen(function* () {
  yield* claimAndRun // create_worktree
  yield* claimAndRun // install
  yield* claimAndRun // implement
  yield* claimAndRun // assess_changes
  yield* claimAndRun // pre_commit
  return yield* claimAndRun // review
})

describe("Commit late No-Change lifecycle routes", () => {
  it("routes nothing-to-publish NO_CHANGES through Close Issue to Complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-no-change-"))
    const githubCalls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
    }> = []
    const summary = "Data repair finished; no repository changes."
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: () =>
            Effect.succeed({
              _tag: "no_changes" as const,
              completionSummary: summary,
            }),
          closeIssue: (context) =>
            Effect.sync(() => {
              githubCalls.push({
                issueNumber: context.issueNumber,
                workItemId: context.workItemId,
                summary: context.completionSummary ?? "",
              })
            }),
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber: 1204,
            title: "Late no-change",
          })

          const created = yield* lifecycle.implementNow(repository.id, 1204)
          yield* runThroughReview

          const afterCommit = yield* claimAndRun
          expect(afterCommit._tag).toBe("processed")
          if (afterCommit._tag !== "processed") {
            return
          }
          expect(afterCommit.workItem.state).toBe("close_issue")
          expect(afterCommit.workItem.completionSummary).toBe(summary)
          expect(afterCommit.workItem.pullRequestNumber).toBeNull()
          const commitRun = afterCommit.workItem.stepRuns.find(
            (run) => run.step === "commit",
          )
          expect(commitRun?.status).toBe("succeeded")
          expect(commitRun?.reasonCode).toBe("native")

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(githubCalls).toEqual([
            {
              issueNumber: 1204,
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
          expect(afterCleanup.workItem.pullRequestNumber).toBeNull()
          expect(
            afterCleanup.workItem.stepRuns.map((run) => [run.step, run.status]),
          ).toEqual([
            ["create_worktree", "succeeded"],
            ["install_dependencies", "succeeded"],
            ["implement", "succeeded"],
            ["assess_changes", "succeeded"],
            ["pre_commit", "succeeded"],
            ["review", "succeeded"],
            ["commit", "succeeded"],
            ["close_issue", "succeeded"],
            ["local_cleanup", "succeeded"],
          ])
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("Implement Locally pauses before Close Issue after a late No-Change and resumes on Start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-local-no-change-"))
    let closeCalls = 0
    const summary = "Local late no-change summary"
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: () =>
            Effect.succeed({
              _tag: "no_changes" as const,
              completionSummary: summary,
            }),
          closeIssue: () => {
            closeCalls += 1
            return Effect.void
          },
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber: 1205,
            title: "Local late no-change",
          })

          const created = yield* lifecycle.implementLocally(repository.id, 1205)
          expect(created.pauseBeforeStep).toBe("commit")

          const afterReview = yield* runThroughReview
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag !== "processed") {
            return
          }
          expect(afterReview.workItem.state).toBe("commit")
          expect(afterReview.workItem.paused).toBe(true)

          const noneBeforeStart = yield* queue.rawClaim(
            WORK_ITEM_LIFECYCLE_QUEUE,
          )
          expect(Option.isNone(noneBeforeStart)).toBe(true)

          yield* lifecycle.start(created.id)
          const afterCommit = yield* claimAndRun
          expect(afterCommit._tag).toBe("processed")
          if (afterCommit._tag !== "processed") {
            return
          }
          expect(afterCommit.workItem.state).toBe("close_issue")
          expect(afterCommit.workItem.paused).toBe(true)
          expect(afterCommit.workItem.pauseBeforeStep).toBe("close_issue")
          expect(afterCommit.workItem.completionSummary).toBe(summary)
          expect(closeCalls).toBe(0)

          const noneAfterPause = yield* queue.rawClaim(
            WORK_ITEM_LIFECYCLE_QUEUE,
          )
          expect(Option.isNone(noneAfterPause)).toBe(true)

          const started = yield* lifecycle.start(afterCommit.workItem.id)
          expect(started.paused).toBe(false)
          expect(started.state).toBe("close_issue")

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(closeCalls).toBe(1)
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails Commit retryably when nothing to publish is classified as CHANGES", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-changes-"))
    let closeCalls = 0
    let createPrCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: () =>
            Effect.fail(
              new CommitNoChangeConfirmationError({
                workItemId: "unused",
                message: "OpenCode did not confirm a No-Change Outcome",
              }),
            ),
          createPr: () => {
            createPrCalls += 1
            return Effect.succeed({
              pullRequestNumber: 1,
              completion: "native" as const,
              publicationTitle: "feat: test",
              publicationBody: "Why\n\nCloses #1",
            })
          },
          closeIssue: () => {
            closeCalls += 1
            return Effect.void
          },
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber: 1206,
            title: "Late CHANGES",
          })

          yield* lifecycle.implementNow(repository.id, 1206)
          yield* runThroughReview
          const failed = yield* claimAndRun
          expect(failed._tag).toBe("processed")
          if (failed._tag !== "processed") {
            return
          }
          expect(failed.workItem.state).toBe("commit")
          expect(failed.workItem.pullRequestNumber).toBeNull()
          expect(failed.workItem.stepRuns.at(-1)?.status).toBe("failed")
          expect(failed.workItem.stepRuns.at(-1)?.reasonMessage).toContain(
            "did not confirm a No-Change Outcome",
          )
          expect(closeCalls).toBe(0)
          expect(createPrCalls).toBe(0)

          const retried = yield* lifecycle.retry(failed.workItem.id)
          expect(retried.state).toBe("commit")
          expect(retried.stepRuns.at(-1)?.status).toBe("queued")
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails Commit retryably on a malformed late confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-malformed-"))
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: () =>
            Effect.fail(
              new CommitNoChangeConfirmationError({
                workItemId: "unused",
                message:
                  "OpenCode did not return a valid READY_FOR_AGENT_RESULT: CHANGES or NO_CHANGES with a non-blank summary when required",
              }),
            ),
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber: 1207,
            title: "Malformed late confirm",
          })

          yield* lifecycle.implementNow(repository.id, 1207)
          yield* runThroughReview
          const failed = yield* claimAndRun
          expect(failed._tag).toBe("processed")
          if (failed._tag !== "processed") {
            return
          }
          expect(failed.workItem.state).toBe("commit")
          expect(failed.workItem.completionSummary).toBeNull()
          expect(failed.workItem.stepRuns.at(-1)?.status).toBe("failed")

          const retried = yield* lifecycle.retry(failed.workItem.id)
          expect(retried.state).toBe("commit")
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retries a late CHANGES failure and Completes after a later NO_CHANGES", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-retry-no-change-"))
    const summary = "Corrected: no repository changes."
    let commitCalls = 0
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: () => {
            commitCalls += 1
            if (commitCalls === 1) {
              return Effect.fail(
                new CommitNoChangeConfirmationError({
                  workItemId: "unused",
                  message: "OpenCode did not confirm a No-Change Outcome",
                }),
              )
            }
            return Effect.succeed({
              _tag: "no_changes" as const,
              completionSummary: summary,
            })
          },
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber: 1208,
            title: "Retry late no-change",
          })

          yield* lifecycle.implementNow(repository.id, 1208)
          yield* runThroughReview
          const failed = yield* claimAndRun
          expect(failed._tag).toBe("processed")
          if (failed._tag !== "processed") {
            return
          }
          expect(failed.workItem.state).toBe("commit")

          yield* lifecycle.retry(failed.workItem.id)
          const afterCommit = yield* claimAndRun
          expect(afterCommit._tag).toBe("processed")
          if (afterCommit._tag !== "processed") {
            return
          }
          expect(afterCommit.workItem.state).toBe("close_issue")
          expect(afterCommit.workItem.completionSummary).toBe(summary)

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          const afterCleanup = yield* claimAndRun
          expect(afterCleanup._tag).toBe("processed")
          if (afterCleanup._tag === "processed") {
            expect(afterCleanup.workItem.state).toBe("complete")
          }
          expect(commitCalls).toBe(2)
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("advances to Close Issue when late NO_CHANGES finds the Issue already CLOSED", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-already-closed-"))
    const githubCalls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
    }> = []
    const summary =
      "Closed the Issue during Implement; no repository changes remain."
    const issueNumber = 1209
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: (context) =>
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.storeIssue({
                repositoryId: context.repositoryId,
                issueNumber,
                title: "Already closed",
                body: "body",
                url: `https://github.com/acme/widgets/issues/${issueNumber}`,
                state: "CLOSED",
                githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
                issueAuthor: null,
                parent: null,
                parentPosition: null,
                hasChildren: false,
                blockedBy: [],
              })
              return {
                _tag: "no_changes" as const,
                completionSummary: summary,
              }
            }),
          closeIssue: (context) =>
            Effect.sync(() => {
              githubCalls.push({
                issueNumber: context.issueNumber,
                workItemId: context.workItemId,
                summary: context.completionSummary ?? "",
              })
            }),
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber,
            title: "Already closed",
          })

          const created = yield* lifecycle.implementNow(
            repository.id,
            issueNumber,
          )
          yield* runThroughReview

          const afterCommit = yield* claimAndRun
          expect(afterCommit._tag).toBe("processed")
          if (afterCommit._tag !== "processed") {
            return
          }
          expect(afterCommit.workItem.state).toBe("close_issue")
          expect(afterCommit.workItem.failureCode).toBeNull()
          expect(afterCommit.workItem.completionSummary).toBe(summary)

          const afterClose = yield* claimAndRun
          expect(afterClose._tag).toBe("processed")
          if (afterClose._tag !== "processed") {
            return
          }
          expect(afterClose.workItem.state).toBe("local_cleanup")
          expect(githubCalls).toEqual([
            {
              issueNumber,
              workItemId: created.id,
              summary,
            },
          ])
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("still fails terminally when late NO_CHANGES revalidation finds a missing Issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-commit-missing-issue-"))
    const issueNumber = 1210
    try {
      const { worktree, startingCommitOid } = await initWorktreeRepo(root)
      const steps = baseSteps({
        worktree,
        startingCommitOid,
        overrides: {
          commit: (context) =>
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.deleteIssue(context.repositoryId, issueNumber)
              return {
                _tag: "no_changes" as const,
                completionSummary: "Gone.",
              }
            }),
          closeIssue: () =>
            Effect.fail(
              new LifecycleStepFailedError({
                message: "Close Issue must not run for a missing Issue",
              }),
            ),
          ...prLaneMustNotRun,
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* seedConfigAndIssue({
            worktree,
            issueNumber,
            title: "Missing after commit",
          })

          const created = yield* lifecycle.implementNow(
            repository.id,
            issueNumber,
          )
          yield* runThroughReview
          const failed = yield* claimAndRun
          expect(failed._tag).toBe("processed")
          if (failed._tag !== "processed") {
            return
          }
          expect(failed.workItem.state).toBe("failed")
          expect(failed.workItem.failureCode).toBe("issue_not_found")

          yield* db.storeIssue({
            repositoryId: repository.id,
            issueNumber,
            title: "Restored",
            body: "body",
            url: `https://github.com/acme/widgets/issues/${issueNumber}`,
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            issueAuthor: null,
            parent: null,
            parentPosition: null,
            hasChildren: false,
            blockedBy: [],
          })

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("commit")
          expect(retried.stepRuns.at(-1)).toMatchObject({
            step: "commit",
            status: "queued",
          })
        }).pipe(Effect.provide(lifecycleLayer(steps))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
