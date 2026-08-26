import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import {
  AzureDevOpsRequestError,
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "@ready-for-agent/azure-devops-service"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  formatUserFacingError,
} from "@ready-for-agent/github-service"
import {
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  type LifecycleStepContext,
  MarkPrReadyForReviewPostconditionError,
  makeWorkItemId,
  markPrReadyForReview,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  issueNumber: 42,
  issueTitle: null,
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})

const notADraftStatus = {
  _tag: "succeeded" as const,
  terminalChecks: [],
  mergeability: "mergeable" as const,
  baseRefName: "main",
  headPushedAt: null,
  headSha: null,
  createdAt: null,
  isDraft: false,
}

const stillDraftStatus = { ...notADraftStatus, isDraft: true }

type ContinueTurnInput = {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly timeout?: unknown
}

const stubOpencode = (
  continueTurn?: (
    input: ContinueTurnInput,
  ) => Effect.Effect<{ sessionId: string; assistantText: string }, never>,
) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: () =>
        Effect.succeed({ sessionId: "ses_start_unused", assistantText: "" }),
      continueTurn:
        continueTurn ??
        (() => Effect.die("Agent Turn must not run for this scenario")),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

describe("markPrReadyForReview", () => {
  it("marks the deterministic Work Item branch PR ready for review natively, without invoking the agent", async () => {
    let requestedBranch = ""
    let markedReady = false
    const github = Layer.succeed(GitHubService, {
      getPullRequestCheckStatus: () =>
        Effect.succeed(markedReady ? notADraftStatus : stillDraftStatus),
      markPullRequestReadyForReview: (_repository, branch) => {
        requestedBranch = branch
        markedReady = true
        return Effect.void
      },
    } as GitHubServiceShape)

    const result = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.mergeAll(db, github, stubOpencode())),
      ),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
    expect(result.completion).toBe("native")
  })

  it("requires a worktree path", async () => {
    const github = Layer.succeed(GitHubService, {
      getPullRequestCheckStatus: () => Effect.succeed(notADraftStatus),
      markPullRequestReadyForReview: () => Effect.void,
    } as GitHubServiceShape)

    const exit = await Effect.runPromise(
      Effect.exit(
        markPrReadyForReview({ ...context, worktreePath: null }).pipe(
          Effect.provide(Layer.mergeAll(db, github, stubOpencode())),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("marks a GitLab draft MR ready for review without querying GitHub", async () => {
    let githubCalls = 0
    let gitlabBranch = ""
    let markedReady = false
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/widgets",
      localPath: "/repos/widgets",
    })
    const gitlabDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([gitlabRepository]),
    })
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () => {
        githubCalls += 1
        return Effect.void
      },
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      getPullRequestCheckStatus: () =>
        Effect.succeed(markedReady ? notADraftStatus : stillDraftStatus),
      markPullRequestReadyForReview: (_repository, branch) => {
        gitlabBranch = branch
        markedReady = true
        return Effect.void
      },
    } as GitLabServiceShape)

    const result = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(
          Layer.mergeAll(gitlabDb, github, gitlab, stubOpencode()),
        ),
      ),
    )

    expect(githubCalls).toBe(0)
    expect(gitlabBranch).toBe(`rfa/project-widgets/42/${context.workItemId}`)
    expect(result.completion).toBe("native")
  })

  it("marks an Azure DevOps draft PR ready for review without querying GitHub", async () => {
    let githubCalls = 0
    let azureDevOpsBranch = ""
    let markedReady = false
    const azureDevOpsRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
      localPath: "/repos/widgets",
    })
    const azureDevOpsDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([azureDevOpsRepository]),
    })
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () => {
        githubCalls += 1
        return Effect.void
      },
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      getPullRequestCheckStatus: () =>
        Effect.succeed(markedReady ? notADraftStatus : stillDraftStatus),
      markPullRequestReadyForReview: (_repository, branch) => {
        azureDevOpsBranch = branch
        markedReady = true
        return Effect.void
      },
    } as AzureDevOpsServiceShape)

    const result = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(
          Layer.mergeAll(azureDevOpsDb, github, azureDevOps, stubOpencode()),
        ),
      ),
    )

    expect(githubCalls).toBe(0)
    expect(azureDevOpsBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
    expect(result.completion).toBe("native")
  })

  it("falls back to one Agent Turn and succeeds when the Agent Turn establishes ready-for-review", async () => {
    let agentRan = false
    let receivedPrompt = ""
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () =>
        Effect.fail(
          new GitHubRequestError({ message: "mark ready unavailable" }),
        ),
      getPullRequestCheckStatus: () =>
        Effect.succeed(agentRan ? notADraftStatus : stillDraftStatus),
    } as GitHubServiceShape)
    const opencode = stubOpencode((input) => {
      agentRan = true
      receivedPrompt = input.prompt
      return Effect.succeed({ sessionId: input.sessionId, assistantText: "" })
    })

    const result = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.mergeAll(db, github, opencode)),
      ),
    )

    expect(result.completion).toBe("agent_fallback")
    expect(agentRan).toBe(true)
    expect(receivedPrompt).toContain("mark ready unavailable")
    expect(receivedPrompt).toContain(
      `rfa/acme-widgets/42/${context.workItemId}`,
    )
  })

  it("goes to Needs Human (surfaces MarkPrReadyForReviewPostconditionError) when native and Agent Turn fallback both fail", async () => {
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () =>
        Effect.fail(
          new GitHubRequestError({
            message:
              "Failed to mark pull request ready for review for acme/widgets:branch",
            statusCode: 401,
            cause: Object.assign(new Error("Unauthorized: Bad credentials"), {
              statusCode: 401,
            }),
          }),
        ),
      getPullRequestCheckStatus: () => Effect.succeed(stillDraftStatus),
    } as GitHubServiceShape)
    const opencode = stubOpencode(() =>
      Effect.succeed({ sessionId: "ses_implement", assistantText: "" }),
    )

    const error = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.mergeAll(db, github, opencode)),
        Effect.flip,
      ),
    )

    expect(error).toBeInstanceOf(MarkPrReadyForReviewPostconditionError)
    const flattened = formatUserFacingError(error)
    expect(flattened).toContain("HTTP 401")
    expect(error.diagnostics).toContain("HTTP 401")
  })

  it("never trusts the native call's own report: a native success that leaves the PR draft still falls back to the agent", async () => {
    let agentRan = false
    let markReadyCalls = 0
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () => {
        markReadyCalls += 1
        return Effect.void
      },
      getPullRequestCheckStatus: () =>
        Effect.succeed(agentRan ? notADraftStatus : stillDraftStatus),
    } as GitHubServiceShape)
    const opencode = stubOpencode((input) => {
      agentRan = true
      return Effect.succeed({ sessionId: input.sessionId, assistantText: "" })
    })

    const result = await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.mergeAll(db, github, opencode)),
      ),
    )

    expect(markReadyCalls).toBe(1)
    expect(agentRan).toBe(true)
    expect(result.completion).toBe("agent_fallback")
  })

  it("wires the GitLab and Azure DevOps forges the same way for fallback failures", async () => {
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/widgets",
      localPath: "/repos/widgets",
    })
    const gitlabDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([gitlabRepository]),
    })
    const gitlab = Layer.succeed(GitLabService, {
      markPullRequestReadyForReview: () =>
        Effect.fail(new GitLabRequestError({ message: "mark ready failed" })),
      getPullRequestCheckStatus: () => Effect.succeed(stillDraftStatus),
    } as GitLabServiceShape)
    const opencode = stubOpencode(() =>
      Effect.succeed({ sessionId: "ses_implement", assistantText: "" }),
    )

    const exit = await Effect.runPromise(
      Effect.exit(
        markPrReadyForReview(context).pipe(
          Effect.provide(Layer.mergeAll(gitlabDb, gitlab, opencode)),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")

    const azureDevOpsRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
      localPath: "/repos/widgets",
    })
    const azureDevOpsDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([azureDevOpsRepository]),
    })
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      markPullRequestReadyForReview: () =>
        Effect.fail(
          new AzureDevOpsRequestError({ message: "mark ready failed" }),
        ),
      getPullRequestCheckStatus: () => Effect.succeed(stillDraftStatus),
    } as AzureDevOpsServiceShape)

    const azureExit = await Effect.runPromise(
      Effect.exit(
        markPrReadyForReview(context).pipe(
          Effect.provide(Layer.mergeAll(azureDevOpsDb, azureDevOps, opencode)),
        ),
      ),
    )
    expect(azureExit._tag).toBe("Failure")
  })
})
