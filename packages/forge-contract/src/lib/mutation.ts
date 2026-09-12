import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import type {
  CreateDraftPullRequestInput,
  ForgeRepository,
  MergePullRequestOptions,
  MergePullRequestResult,
  UpdateDraftPullRequestCopyInput,
} from "./types.js"

/**
 * Shared native PR mutations: draft create, draft-copy reconcile, mark
 * ready, and merge. Cleanup is not on this surface — GitHub combines PR
 * close with branch delete, while GitLab and Azure DevOps expose those as
 * two sequential operations.
 */
export interface ForgePullRequestMutations<E = unknown> {
  /**
   * Create a draft pull/merge request for head against the default base
   * (or an explicit base). Returns the new number. Does not push the head
   * branch; the caller must ensure the remote head exists.
   */
  readonly createDraftPullRequest: (
    repository: ForgeRepository,
    input: CreateDraftPullRequestInput,
  ) => Effect.Effect<number, E>
  /**
   * When an open draft exists for the exact head/source branch, set its
   * title and body. Non-draft open PRs/MRs are left unchanged. Returns the
   * open number when one exists, otherwise null.
   */
  readonly updateOpenDraftPullRequestCopy: (
    repository: ForgeRepository,
    headRefName: string,
    input: UpdateDraftPullRequestCopyInput,
  ) => Effect.Effect<number | null, E>
  /**
   * Clear the draft flag so the pull/merge request is ready for review.
   * Idempotent when already non-draft.
   */
  readonly markPullRequestReadyForReview: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<void, E>
  /**
   * Merge the open pull/merge request on the exact head/source branch with
   * expected-head protection. GitHub squash-merges; GitLab and Azure
   * DevOps defer merge method to project settings. Already-merged is
   * success; closed-unmerged and state races use MergePullRequestResult.
   */
  readonly mergePullRequest: (
    repository: ForgeRepository,
    headRefName: string,
    options?: MergePullRequestOptions,
  ) => Effect.Effect<MergePullRequestResult, E>
}

/**
 * GitHub remote cleanup: close every open PR for the exact head branch,
 * then delete that branch, as one service operation so the GitHub
 * Operation Coordinator permit spans list, every sequential close, and
 * the final delete. An absent branch is the successful postcondition.
 * Retries re-list remaining open PRs.
 */
export interface ForgeCombinedRemoteCleanup<E = unknown> {
  readonly closeOpenPullRequestsAndDeleteBranch: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<void, E>
}

/**
 * GitLab and Azure DevOps remote cleanup: close/abandon matching open
 * PRs/MRs, then delete the branch, as two sequential operations. Missing
 * PRs/MRs and missing branches are success. Callers must not delete when
 * close failed; a retry after close succeeded and delete failed repeats
 * close (idempotent) then delete.
 */
export interface ForgeSequentialRemoteCleanup<E = unknown> {
  readonly closeOpenPullRequestsForBranch: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<void, E>
  readonly deleteBranch: (
    repository: ForgeRepository,
    branchName: string,
  ) => Effect.Effect<void, E>
}

/**
 * Azure Boards ArtifactLink from an existing pull request to the Issue.
 * Idempotent: a missing link is added; an already-present link is left
 * unchanged. Not a textual `Closes #N` mention. GitHub and GitLab have no
 * equivalent native association write.
 */
export interface ForgeAzurePullRequestAssociation<E = unknown> {
  readonly ensurePullRequestLinkedToIssue: (
    repository: ForgeRepository,
    pullRequestNumber: number,
    issueNumber: number,
  ) => Effect.Effect<void, E>
}

/**
 * Azure Boards completion-with-summary used only after a native Merge PR
 * success. Not a generic closes-on-merge capability: GitHub and GitLab
 * still close via native PR closing references, and human-observed merge
 * paths do not use this operation.
 */
export interface ForgeAzurePostMergeIssueCompletion<E = unknown> {
  readonly ensureIssueCompletedWithSummary: (
    repository: ForgeRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, E>
}

export type ForgeCombinedRemoteCleanupView<E = unknown> = {
  readonly kind: "combined"
} & ForgeCombinedRemoteCleanup<E>

export type ForgeSequentialRemoteCleanupView<E = unknown> = {
  readonly kind: "sequential"
} & ForgeSequentialRemoteCleanup<E>

export type ResolvedGitHubPullRequestMutations<E = unknown> =
  ForgePullRequestMutations<E> & {
    readonly forge: "github"
    readonly remoteCleanup: ForgeCombinedRemoteCleanupView<E>
  }

export type ResolvedGitLabPullRequestMutations<E = unknown> =
  ForgePullRequestMutations<E> & {
    readonly forge: "gitlab"
    readonly remoteCleanup: ForgeSequentialRemoteCleanupView<E>
  }

export type ResolvedAzureDevOpsPullRequestMutations<E = unknown> =
  ForgePullRequestMutations<E> &
    ForgeAzurePullRequestAssociation<E> &
    ForgeAzurePostMergeIssueCompletion<E> & {
      readonly forge: "azure-devops"
      readonly remoteCleanup: ForgeSequentialRemoteCleanupView<E>
    }

/**
 * Provider-neutral internal view of existing Forge PR mutations plus the
 * provider's existing cleanup shape. Azure extras stay Azure-only.
 */
export type ResolvedForgePullRequestMutations<E = unknown> =
  | ResolvedGitHubPullRequestMutations<E>
  | ResolvedGitLabPullRequestMutations<E>
  | ResolvedAzureDevOpsPullRequestMutations<E>

export interface ForgeGitHubPullRequestMutations<E = unknown>
  extends ForgePullRequestMutations<E>,
    ForgeCombinedRemoteCleanup<E> {}

export interface ForgeGitLabPullRequestMutations<E = unknown>
  extends ForgePullRequestMutations<E>,
    ForgeSequentialRemoteCleanup<E> {}

export interface ForgeAzureDevOpsPullRequestMutations<E = unknown>
  extends ForgePullRequestMutations<E>,
    ForgeSequentialRemoteCleanup<E>,
    ForgeAzurePullRequestAssociation<E>,
    ForgeAzurePostMergeIssueCompletion<E> {}

export interface ForgePullRequestMutationProviders<GitHubE, GitLabE, AzureE> {
  readonly github: ForgeGitHubPullRequestMutations<GitHubE>
  readonly gitlab: ForgeGitLabPullRequestMutations<GitLabE>
  readonly azureDevOps: ForgeAzureDevOpsPullRequestMutations<AzureE>
}

export const githubPullRequestMutations = <E>(
  github: ForgeGitHubPullRequestMutations<E>,
): ResolvedGitHubPullRequestMutations<E> => ({
  forge: "github",
  createDraftPullRequest: github.createDraftPullRequest,
  updateOpenDraftPullRequestCopy: github.updateOpenDraftPullRequestCopy,
  markPullRequestReadyForReview: github.markPullRequestReadyForReview,
  mergePullRequest: github.mergePullRequest,
  remoteCleanup: {
    kind: "combined",
    closeOpenPullRequestsAndDeleteBranch:
      github.closeOpenPullRequestsAndDeleteBranch,
  },
})

export const gitlabPullRequestMutations = <E>(
  gitlab: ForgeGitLabPullRequestMutations<E>,
): ResolvedGitLabPullRequestMutations<E> => ({
  forge: "gitlab",
  createDraftPullRequest: gitlab.createDraftPullRequest,
  updateOpenDraftPullRequestCopy: gitlab.updateOpenDraftPullRequestCopy,
  markPullRequestReadyForReview: gitlab.markPullRequestReadyForReview,
  mergePullRequest: gitlab.mergePullRequest,
  remoteCleanup: {
    kind: "sequential",
    closeOpenPullRequestsForBranch: gitlab.closeOpenPullRequestsForBranch,
    deleteBranch: gitlab.deleteBranch,
  },
})

export const azureDevOpsPullRequestMutations = <E>(
  azureDevOps: ForgeAzureDevOpsPullRequestMutations<E>,
): ResolvedAzureDevOpsPullRequestMutations<E> => ({
  forge: "azure-devops",
  createDraftPullRequest: azureDevOps.createDraftPullRequest,
  updateOpenDraftPullRequestCopy: azureDevOps.updateOpenDraftPullRequestCopy,
  markPullRequestReadyForReview: azureDevOps.markPullRequestReadyForReview,
  mergePullRequest: azureDevOps.mergePullRequest,
  ensurePullRequestLinkedToIssue: azureDevOps.ensurePullRequestLinkedToIssue,
  ensureIssueCompletedWithSummary: azureDevOps.ensureIssueCompletedWithSummary,
  remoteCleanup: {
    kind: "sequential",
    closeOpenPullRequestsForBranch: azureDevOps.closeOpenPullRequestsForBranch,
    deleteBranch: azureDevOps.deleteBranch,
  },
})

/**
 * Resolve the Repository's existing Forge to the shared PR-mutation view.
 * Cleanup stays combined on GitHub and sequential on GitLab/Azure DevOps.
 * Azure Issue association and post-merge Boards completion are present
 * only on the Azure view.
 */
export const resolveForgePullRequestMutations = <GitHubE, GitLabE, AzureE>(
  forge: Forge,
  providers: ForgePullRequestMutationProviders<GitHubE, GitLabE, AzureE>,
): ResolvedForgePullRequestMutations<GitHubE | GitLabE | AzureE> => {
  switch (forge) {
    case "github":
      return githubPullRequestMutations(providers.github)
    case "gitlab":
      return gitlabPullRequestMutations(providers.gitlab)
    case "azure-devops":
      return azureDevOpsPullRequestMutations(providers.azureDevOps)
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

/**
 * Azure Boards close-out after a native Merge PR success. No-ops when the
 * merge result is not `merged`, so revalidation and needs-human outcomes
 * do not write. Completion failure after a successful merge remains an
 * error so Retry can complete the already-merged PR's Issue.
 */
export const completeAzureBoardsIssueAfterNativeMerge = <E>(input: {
  readonly result: MergePullRequestResult
  readonly completeIssue: ForgeAzurePostMergeIssueCompletion<E>["ensureIssueCompletedWithSummary"]
  readonly repository: ForgeRepository
  readonly issueNumber: number
  readonly workItemId: string
  readonly summaryMarkdown: string
}): Effect.Effect<MergePullRequestResult, E> => {
  if (input.result._tag !== "merged") {
    return Effect.succeed(input.result)
  }
  return input
    .completeIssue(
      input.repository,
      input.issueNumber,
      input.workItemId,
      input.summaryMarkdown,
    )
    .pipe(Effect.as(input.result))
}
