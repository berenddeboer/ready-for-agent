import { Effect, Layer } from "effect"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  type LifecycleStepContext,
  makeWorkItemId,
  mergePr,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})

describe("mergePr", () => {
  it("merges the deterministic Work Item branch PR", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: (_repository, branch) => {
        requestedBranch = branch
        return Effect.void
      },
    } satisfies GitHubServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(Effect.provide(Layer.merge(db, github))),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("requires a worktree path", async () => {
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
    } satisfies GitHubServiceShape)

    const exit = await Effect.runPromise(
      Effect.exit(
        mergePr({ ...context, worktreePath: null }).pipe(
          Effect.provide(Layer.merge(db, github)),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
