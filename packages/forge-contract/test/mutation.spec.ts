import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import {
  type ForgeAzureDevOpsPullRequestMutations,
  type ForgeGitHubPullRequestMutations,
  type ForgeGitLabPullRequestMutations,
  type ForgeRepository,
  type MergePullRequestResult,
  completeAzureBoardsIssueAfterNativeMerge,
  resolveForgePullRequestMutations,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository: ForgeRepository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

const draftInput = {
  headRefName: "rfa/acme-widgets/1/wi-1",
  title: "Implement widgets",
  body: "Closes #1",
}

const copyInput = { title: "Implement widgets", body: "Closes #1" }

const githubProvider = (
  actions: string[],
): ForgeGitHubPullRequestMutations<string> => ({
  createDraftPullRequest: (_repository, input) =>
    Effect.sync(() => {
      actions.push(`github:create:${input.headRefName}`)
      return 11
    }),
  updateOpenDraftPullRequestCopy: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`github:copy:${headRefName}`)
      return 11
    }),
  markPullRequestReadyForReview: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`github:ready:${headRefName}`)
    }),
  mergePullRequest: (_repository, headRefName, options) =>
    Effect.sync(() => {
      actions.push(
        `github:merge:${headRefName}:${options?.acceptNoChecks === true ? "always" : "ordinary"}`,
      )
      return { _tag: "merged" } satisfies MergePullRequestResult
    }),
  closeOpenPullRequestsAndDeleteBranch: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`github:combined-cleanup:${headRefName}`)
    }),
})

const gitlabProvider = (
  actions: string[],
  options: {
    readonly close?: Effect.Effect<void, string>
    readonly delete?: Effect.Effect<void, string>
  } = {},
): ForgeGitLabPullRequestMutations<string> => ({
  createDraftPullRequest: (_repository, input) =>
    Effect.sync(() => {
      actions.push(`gitlab:create:${input.headRefName}`)
      return 22
    }),
  updateOpenDraftPullRequestCopy: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`gitlab:copy:${headRefName}`)
      return 22
    }),
  markPullRequestReadyForReview: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`gitlab:ready:${headRefName}`)
    }),
  mergePullRequest: (_repository, headRefName, mergeOptions) =>
    Effect.sync(() => {
      actions.push(
        `gitlab:merge:${headRefName}:${mergeOptions?.acceptNoChecks === true ? "always" : "ordinary"}`,
      )
      return { _tag: "merged" } satisfies MergePullRequestResult
    }),
  closeOpenPullRequestsForBranch: (_repository, headRefName) =>
    options.close ??
    Effect.sync(() => {
      actions.push(`gitlab:close:${headRefName}`)
    }),
  deleteBranch: (_repository, branchName) =>
    options.delete ??
    Effect.sync(() => {
      actions.push(`gitlab:delete:${branchName}`)
    }),
})

const azureProvider = (
  actions: string[],
  options: {
    readonly close?: Effect.Effect<void, string>
    readonly delete?: Effect.Effect<void, string>
    readonly complete?: Effect.Effect<void, string>
  } = {},
): ForgeAzureDevOpsPullRequestMutations<string> => ({
  createDraftPullRequest: (_repository, input) =>
    Effect.sync(() => {
      actions.push(`azure:create:${input.headRefName}`)
      return 33
    }),
  updateOpenDraftPullRequestCopy: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`azure:copy:${headRefName}`)
      return 33
    }),
  markPullRequestReadyForReview: (_repository, headRefName) =>
    Effect.sync(() => {
      actions.push(`azure:ready:${headRefName}`)
    }),
  mergePullRequest: (_repository, headRefName, mergeOptions) =>
    Effect.sync(() => {
      actions.push(
        `azure:merge:${headRefName}:${mergeOptions?.acceptNoChecks === true ? "always" : "ordinary"}`,
      )
      return { _tag: "merged" } satisfies MergePullRequestResult
    }),
  closeOpenPullRequestsForBranch: (_repository, headRefName) =>
    options.close ??
    Effect.sync(() => {
      actions.push(`azure:close:${headRefName}`)
    }),
  deleteBranch: (_repository, branchName) =>
    options.delete ??
    Effect.sync(() => {
      actions.push(`azure:delete:${branchName}`)
    }),
  ensurePullRequestLinkedToIssue: (
    _repository,
    pullRequestNumber,
    issueNumber,
  ) =>
    Effect.sync(() => {
      actions.push(`azure:link:${pullRequestNumber}:${issueNumber}`)
    }),
  ensureIssueCompletedWithSummary: (
    _repository,
    issueNumber,
    workItemId,
    summaryMarkdown,
  ) =>
    options.complete ??
    Effect.sync(() => {
      actions.push(
        `azure:complete:${issueNumber}:${workItemId}:${summaryMarkdown}`,
      )
    }),
})

const providersFor = (actions: string[]) => ({
  github: githubProvider(actions),
  gitlab: gitlabProvider(actions),
  azureDevOps: azureProvider(actions),
})

const resolve = (forge: Forge, actions: string[]) =>
  resolveForgePullRequestMutations(forge, providersFor(actions))

const runSequentialCleanup = <E>(
  cleanup: {
    readonly kind: "sequential"
    readonly closeOpenPullRequestsForBranch: (
      repository: ForgeRepository,
      headRefName: string,
    ) => Effect.Effect<void, E>
    readonly deleteBranch: (
      repository: ForgeRepository,
      branchName: string,
    ) => Effect.Effect<void, E>
  },
  branch: string,
) =>
  Effect.gen(function* () {
    yield* cleanup.closeOpenPullRequestsForBranch(repository, branch)
    yield* cleanup.deleteBranch(repository, branch)
  })

describe("resolveForgePullRequestMutations", () => {
  it("routes create, draft-copy, mark-ready, and merge to the selected Forge only", async () => {
    const actions: string[] = []
    const github = resolve("github", actions)
    const gitlab = resolve("gitlab", actions)
    const azure = resolve("azure-devops", actions)

    expect(
      await Effect.runPromise(
        github.createDraftPullRequest(repository, draftInput),
      ),
    ).toBe(11)
    expect(
      await Effect.runPromise(
        gitlab.updateOpenDraftPullRequestCopy(
          repository,
          draftInput.headRefName,
          copyInput,
        ),
      ),
    ).toBe(22)
    await Effect.runPromise(
      azure.markPullRequestReadyForReview(repository, draftInput.headRefName),
    )
    await Effect.runPromise(
      github.mergePullRequest(repository, draftInput.headRefName, {
        acceptNoChecks: true,
      }),
    )

    expect(actions).toEqual([
      "github:create:rfa/acme-widgets/1/wi-1",
      "gitlab:copy:rfa/acme-widgets/1/wi-1",
      "azure:ready:rfa/acme-widgets/1/wi-1",
      "github:merge:rfa/acme-widgets/1/wi-1:always",
    ])
  })

  it("exposes GitHub cleanup as one combined close-and-delete operation", async () => {
    const actions: string[] = []
    const mutations = resolve("github", actions)

    expect(mutations.forge).toBe("github")
    expect(mutations.remoteCleanup.kind).toBe("combined")
    if (mutations.remoteCleanup.kind !== "combined") {
      throw new Error("expected combined GitHub cleanup")
    }
    await Effect.runPromise(
      mutations.remoteCleanup.closeOpenPullRequestsAndDeleteBranch(
        repository,
        draftInput.headRefName,
      ),
    )

    expect(actions).toEqual(["github:combined-cleanup:rfa/acme-widgets/1/wi-1"])
  })

  it("exposes GitLab and Azure cleanup as close then delete", async () => {
    for (const forge of ["gitlab", "azure-devops"] as const) {
      const actions: string[] = []
      const mutations = resolve(forge, actions)
      expect(mutations.remoteCleanup.kind).toBe("sequential")
      if (mutations.remoteCleanup.kind !== "sequential") {
        throw new Error("expected sequential cleanup")
      }
      await Effect.runPromise(
        runSequentialCleanup(mutations.remoteCleanup, draftInput.headRefName),
      )
      const prefix = forge === "gitlab" ? "gitlab" : "azure"
      expect(actions).toEqual([
        `${prefix}:close:rfa/acme-widgets/1/wi-1`,
        `${prefix}:delete:rfa/acme-widgets/1/wi-1`,
      ])
    }
  })

  it("does not delete the branch when sequential close fails", async () => {
    const actions: string[] = []
    const mutations = resolveForgePullRequestMutations("gitlab", {
      github: githubProvider(actions),
      gitlab: gitlabProvider(actions, {
        close: Effect.sync(() => {
          actions.push("gitlab:close")
        }).pipe(Effect.flatMap(() => Effect.fail("close failed"))),
      }),
      azureDevOps: azureProvider(actions),
    })
    if (mutations.remoteCleanup.kind !== "sequential") {
      throw new Error("expected sequential cleanup")
    }

    const error = await Effect.runPromise(
      runSequentialCleanup(
        mutations.remoteCleanup,
        draftInput.headRefName,
      ).pipe(Effect.flip),
    )

    expect(error).toBe("close failed")
    expect(actions).toEqual(["gitlab:close"])
  })

  it("keeps a successful sequential close when the following delete fails", async () => {
    const actions: string[] = []
    const mutations = resolveForgePullRequestMutations("azure-devops", {
      github: githubProvider(actions),
      gitlab: gitlabProvider(actions),
      azureDevOps: azureProvider(actions, {
        delete: Effect.sync(() => {
          actions.push("azure:delete")
        }).pipe(Effect.flatMap(() => Effect.fail("delete failed"))),
      }),
    })
    if (mutations.remoteCleanup.kind !== "sequential") {
      throw new Error("expected sequential cleanup")
    }

    const error = await Effect.runPromise(
      runSequentialCleanup(
        mutations.remoteCleanup,
        draftInput.headRefName,
      ).pipe(Effect.flip),
    )

    expect(error).toBe("delete failed")
    expect(actions).toEqual([
      "azure:close:rfa/acme-widgets/1/wi-1",
      "azure:delete",
    ])
  })

  it("keeps Azure Issue association and post-merge completion on the Azure view only", async () => {
    const actions: string[] = []
    const github = resolve("github", actions)
    const gitlab = resolve("gitlab", actions)
    const azure = resolve("azure-devops", actions)

    expect(github.forge).toBe("github")
    expect(gitlab.forge).toBe("gitlab")
    expect(azure.forge).toBe("azure-devops")
    expect("ensurePullRequestLinkedToIssue" in github).toBe(false)
    expect("ensurePullRequestLinkedToIssue" in gitlab).toBe(false)
    expect("ensureIssueCompletedWithSummary" in github).toBe(false)
    expect("ensureIssueCompletedWithSummary" in gitlab).toBe(false)

    await Effect.runPromise(
      azure.ensurePullRequestLinkedToIssue(repository, 33, 7),
    )
    expect(actions).toEqual(["azure:link:33:7"])
  })
})

describe("completeAzureBoardsIssueAfterNativeMerge", () => {
  it("completes the Boards Issue only after a native merge success", async () => {
    const actions: string[] = []
    const azure = azureProvider(actions)

    const merged = await Effect.runPromise(
      completeAzureBoardsIssueAfterNativeMerge({
        result: { _tag: "merged" },
        completeIssue: azure.ensureIssueCompletedWithSummary,
        repository,
        issueNumber: 42,
        workItemId: "wi-1",
        summaryMarkdown: "Completed after the pull request merged.",
      }),
    )
    const skipped = await Effect.runPromise(
      completeAzureBoardsIssueAfterNativeMerge({
        result: {
          _tag: "needs_human",
          reason: "merge_rejected",
          message: "Azure DevOps rejected the merge",
        },
        completeIssue: azure.ensureIssueCompletedWithSummary,
        repository,
        issueNumber: 42,
        workItemId: "wi-1",
        summaryMarkdown: "Completed after the pull request merged.",
      }),
    )

    expect(merged).toEqual({ _tag: "merged" })
    expect(skipped._tag).toBe("needs_human")
    expect(actions).toEqual([
      "azure:complete:42:wi-1:Completed after the pull request merged.",
    ])
  })

  it("fails when merge succeeded but Boards completion fails", async () => {
    const actions: string[] = []
    const azure = azureProvider(actions, {
      complete: Effect.sync(() => {
        actions.push("azure:complete")
      }).pipe(Effect.flatMap(() => Effect.fail("completion failed"))),
    })

    const error = await Effect.runPromise(
      completeAzureBoardsIssueAfterNativeMerge({
        result: { _tag: "merged" },
        completeIssue: azure.ensureIssueCompletedWithSummary,
        repository,
        issueNumber: 42,
        workItemId: "wi-1",
        summaryMarkdown: "Completed after the pull request merged.",
      }).pipe(Effect.flip),
    )

    expect(error).toBe("completion failed")
    expect(actions).toEqual(["azure:complete"])
  })
})
