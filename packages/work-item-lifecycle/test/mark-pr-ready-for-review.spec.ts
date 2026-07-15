import { Effect, Layer } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  type LifecycleStepContext,
  makeWorkItemId,
  markPrReadyForReview,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = {
  id: "repo-test",
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/widgets",
  isBare: true,
  paused: false,
  defaultModel: null,
  defaultVariant: null,
  autoMerge: false,
  issuesReconciledAt: null,
}

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  worktreePath: "/tmp/worktree",
  sessionId: "ses_implement",
}

const db = Layer.succeed(DbService, {
  listRepositories: Effect.succeed([repository]),
} as DbServiceShape)

describe("markPrReadyForReview", () => {
  it("marks the deterministic Work Item branch PR ready for review", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getPullRequestCheckStatus: () =>
        Effect.succeed({ _tag: "succeeded", terminalChecks: [] }),
      markPullRequestReadyForReview: (_repository, branch) => {
        requestedBranch = branch
        return Effect.void
      },
    } satisfies GitHubServiceShape)

    await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.merge(db, github)),
      ),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("requires a worktree path", async () => {
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getPullRequestCheckStatus: () =>
        Effect.succeed({ _tag: "succeeded", terminalChecks: [] }),
      markPullRequestReadyForReview: () => Effect.void,
    } satisfies GitHubServiceShape)

    const exit = await Effect.runPromise(
      Effect.exit(
        markPrReadyForReview({ ...context, worktreePath: null }).pipe(
          Effect.provide(Layer.merge(db, github)),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
