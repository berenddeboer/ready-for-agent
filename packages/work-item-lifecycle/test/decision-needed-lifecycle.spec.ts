import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  STEP_RUN_REASON,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
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

const unusedSteps = {
  review: () => Effect.die("review must not run"),
  commit: () => Effect.die("commit must not run"),
  createPr: () => Effect.die("create PR must not run"),
  watchPrStatusChecks: () => Effect.die("watch must not run"),
  resolvePrMergeConflict: () => Effect.die("resolve must not run"),
  investigatePrStatusChecks: () => Effect.die("investigate must not run"),
  markPrReadyForReview: () => Effect.die("mark ready must not run"),
  decidePrMerge: () => Effect.die("decide must not run"),
  mergePr: () => Effect.die("merge must not run"),
  closeIssue: () => Effect.die("close issue must not run"),
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
} satisfies Partial<LifecycleStepsShape>

describe("Decision needed lifecycle handoff", () => {
  it("parks Implement immediately and resumes the same session without a competing turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-decision-needed-"))
    const calls = { assess: 0, preCommit: 0, implement: 0 }
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
          calls.implement += 1
          if (calls.implement === 1) {
            return Effect.succeed({
              _tag: "decision_needed" as const,
              sessionId: "ses_decision",
              request:
                "Should private-repository onboarding use signed enrollment or a GitHub App?",
            })
          }
          return Effect.succeed("ses_decision")
        },
        assessChanges: () => {
          calls.assess += 1
          return Effect.succeed({ _tag: "changes" as const })
        },
        preCommit: () => {
          calls.preCommit += 1
          return Effect.void
        },
        ...unusedSteps,
      }
      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
        Layer.provideMerge(stubGitHubServiceLayer()),
        Layer.provideMerge(stubGitLabServiceLayer()),
        Layer.provideMerge(stubAzureDevOpsServiceLayer()),
        Layer.provideMerge(stubLinearServiceLayer()),
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
            localPath: worktree,
            isBare: false,
          })
          yield* db.storeIssue({
            repositoryId: repository.id,
            issueNumber: 47,
            title: "Decision needed",
            body: "Ask before expanding scope.",
            url: "https://github.com/acme/widgets/issues/47",
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            issueAuthor: null,
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

          yield* lifecycle.implementNow(repository.id, "47")
          yield* claimAndRun
          yield* claimAndRun
          const afterImplement = yield* claimAndRun
          expect(afterImplement._tag).toBe("processed")
          if (afterImplement._tag !== "processed") {
            return
          }
          expect(afterImplement.workItem.state).toBe("needs_human")
          expect(afterImplement.workItem.failureCode).toBe("decision_needed")
          expect(afterImplement.workItem.failureMessage).toContain(
            "signed enrollment",
          )
          expect(afterImplement.workItem.sessionId).toBe("ses_decision")
          expect(afterImplement.workItem.holdsWorkerSlot).toBe(false)
          expect(afterImplement.workItem.worktreePath).toBe(worktree)
          expect(
            afterImplement.workItem.stepRuns.some(
              (run) =>
                run.step === "implement" &&
                run.status === "succeeded" &&
                run.reasonCode === STEP_RUN_REASON.decisionNeeded,
            ),
          ).toBe(true)
          expect(calls.assess).toBe(0)
          expect(calls.preCommit).toBe(0)

          const resumed = yield* lifecycle.resume(afterImplement.workItem.id)
          expect(resumed.state).toBe("implement")
          expect(resumed.failureCode).toBeNull()
          expect(
            resumed.stepRuns.filter(
              (run) => run.status === "queued" || run.status === "running",
            ),
          ).toHaveLength(1)

          const again = yield* lifecycle.resume(afterImplement.workItem.id)
          expect(
            again.stepRuns.filter(
              (run) => run.status === "queued" || run.status === "running",
            ),
          ).toHaveLength(1)
          expect(
            again.stepRuns.filter((run) => run.step === "implement"),
          ).toHaveLength(
            resumed.stepRuns.filter((run) => run.step === "implement").length,
          )
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
