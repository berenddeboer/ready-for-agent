import { Effect, Layer } from "effect"
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
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
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

describe("mergePr", () => {
  it("merges the deterministic Work Item branch PR", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: (_repository, branch, options) => {
        requestedBranch = branch
        expect(options).toBeUndefined()
        return Effect.succeed({ _tag: "merged" as const })
      },
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(Effect.provide(Layer.merge(db, github))),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("asks GitHub to accept no_checks only for Always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)

    await Effect.runPromise(
      mergePr({ ...context, mergeMode: "always" }).pipe(
        Effect.provide(Layer.merge(db, github)),
      ),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })

  it("asks GitHub to accept no_checks when an unpinned Work Item inherits live always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)
    const liveAlways = stubDbServiceLayer({
      listRepositories: Effect.succeed([
        { ...repository, mergePolicy: "always" },
      ]),
    })

    await Effect.runPromise(
      mergePr({
        ...context,
        mergeMode: "ordinary",
        autoMergeOverride: null,
      }).pipe(Effect.provide(Layer.merge(liveAlways, github))),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })

  it("does not ask GitHub to accept no_checks when live Merge Policy is classify", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)
    const liveClassify = stubDbServiceLayer({
      listRepositories: Effect.succeed([
        { ...repository, mergePolicy: "classify" },
      ]),
    })

    await Effect.runPromise(
      mergePr({
        ...context,
        mergeMode: "ordinary",
        autoMergeOverride: null,
      }).pipe(Effect.provide(Layer.merge(liveClassify, github))),
    )

    expect(seenOptions).toBeUndefined()
  })

  it("requires a worktree path", async () => {
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
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

  it("merges the deterministic Work Item branch MR for GitLab", async () => {
    let requestedBranch = ""
    let githubCalls = 0
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
      mergePullRequest: () => {
        githubCalls += 1
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: (_repository, branch, options) => {
        requestedBranch = branch
        expect(options).toBeUndefined()
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(requestedBranch).toBe(`rfa/project-widgets/42/${context.workItemId}`)
    expect(githubCalls).toBe(0)
  })

  it("asks GitLab to accept no_checks only for Always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
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
      mergePullRequest: () => Effect.die("GitHub must not merge a GitLab repo"),
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr({ ...context, mergeMode: "always" }).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })

  it("asks GitLab to accept no_checks when an unpinned Work Item inherits live always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/widgets",
      localPath: "/repos/widgets",
      mergePolicy: "always",
    })
    const gitlabDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([gitlabRepository]),
    })
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: () => Effect.die("GitHub must not merge a GitLab repo"),
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr({
        ...context,
        mergeMode: "ordinary",
        autoMergeOverride: null,
      }).pipe(Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab))),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })

  it("merges the deterministic Work Item branch PR for Azure DevOps", async () => {
    let requestedBranch = ""
    let githubCalls = 0
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
      mergePullRequest: () => {
        githubCalls += 1
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: (_repository, branch, options) => {
        requestedBranch = branch
        expect(options).toBeUndefined()
        return Effect.succeed({ _tag: "merged" as const })
      },
      ensureIssueCompletedWithSummary: () => Effect.void,
    } as AzureDevOpsServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
    expect(githubCalls).toBe(0)
  })

  it("asks Azure DevOps to accept no_checks only for Always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
      ensureIssueCompletedWithSummary: () => Effect.void,
    } as AzureDevOpsServiceShape)

    await Effect.runPromise(
      mergePr({ ...context, mergeMode: "always" }).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })

  it("completes a still-open Azure Boards Issue after merge", async () => {
    const closeOutCalls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
      projectPath: string
    }> = []
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
      ensureIssueCompletedWithSummary: () =>
        Effect.die("GitHub must not close an Azure DevOps Issue"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: (
        forgeRepository,
        issueNumber,
        workItemId,
        summaryMarkdown,
      ) =>
        Effect.sync(() => {
          closeOutCalls.push({
            issueNumber,
            workItemId,
            summary: summaryMarkdown,
            projectPath: forgeRepository.projectPath,
          })
        }),
    } as AzureDevOpsServiceShape)

    const result = await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(result).toEqual({ _tag: "merged" })
    expect(closeOutCalls).toEqual([
      {
        issueNumber: 42,
        workItemId: context.workItemId,
        summary: "Completed after the pull request merged.",
        projectPath: "acme/widgets",
      },
    ])
  })

  it("posts the persisted completion summary when Merge PR already has one", async () => {
    const summaries: string[] = []
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: (
        _forgeRepository,
        _issueNumber,
        _workItemId,
        summaryMarkdown,
      ) =>
        Effect.sync(() => {
          summaries.push(summaryMarkdown)
        }),
    } as AzureDevOpsServiceShape)

    await Effect.runPromise(
      mergePr({
        ...context,
        completionSummary: "Findings complete.",
      }).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(summaries).toEqual(["Findings complete."])
  })

  it("still asks Azure to complete the Boards Issue when merge already linked it", async () => {
    const calls: string[] = []
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: () =>
        Effect.sync(() => {
          calls.push("merge")
          return { _tag: "merged" as const }
        }),
      ensureIssueCompletedWithSummary: () =>
        Effect.sync(() => {
          calls.push("close-out")
        }),
    } as AzureDevOpsServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(calls).toEqual(["merge", "close-out"])
  })

  it("does not complete an Azure Boards Issue when merge is not yet merged", async () => {
    let closeOutCalls = 0
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: () =>
        Effect.succeed({
          _tag: "needs_human" as const,
          reason: "merge_rejected" as const,
          message: "Azure DevOps rejected the merge",
        }),
      ensureIssueCompletedWithSummary: () =>
        Effect.sync(() => {
          closeOutCalls += 1
        }),
    } as AzureDevOpsServiceShape)

    const result = await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
      ),
    )

    expect(result._tag).toBe("needs_human")
    expect(closeOutCalls).toBe(0)
  })

  it("fails Merge PR when Azure close-out fails after a successful merge", async () => {
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
      mergePullRequest: () =>
        Effect.die("GitHub must not merge an Azure DevOps repo"),
    } as GitHubServiceShape)
    const azureDevOps = Layer.succeed(AzureDevOpsService, {
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: () =>
        Effect.fail(
          new AzureDevOpsRequestError({
            message:
              "Failed to complete Azure Boards Issue #42 for acme/widgets",
            statusCode: 401,
          }),
        ),
    } as AzureDevOpsServiceShape)

    const error = await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(azureDevOpsDb, github, azureDevOps)),
        Effect.flip,
      ),
    )

    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })

  it("does not close a GitHub Issue after merge", async () => {
    let closeOutCalls = 0
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: () =>
        Effect.sync(() => {
          closeOutCalls += 1
        }),
    } as GitHubServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(Effect.provide(Layer.merge(db, github))),
    )

    expect(closeOutCalls).toBe(0)
  })

  it("does not close a GitLab Issue after merge", async () => {
    let githubCloseOut = 0
    let gitlabCloseOut = 0
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
      mergePullRequest: () => Effect.die("GitHub must not merge a GitLab repo"),
      ensureIssueCompletedWithSummary: () =>
        Effect.sync(() => {
          githubCloseOut += 1
        }),
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: () =>
        Effect.sync(() => {
          gitlabCloseOut += 1
        }),
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(githubCloseOut).toBe(0)
    expect(gitlabCloseOut).toBe(0)
  })
})
