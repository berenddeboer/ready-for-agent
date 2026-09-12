import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import type {
  ForgeRepository,
  IssueAuthorScope,
  ReadyLabeledIssue,
} from "./types.js"

/**
 * Narrow internal view of existing Forge Issue operations. Callers must not
 * treat any one provider as the contract, and must not pass GitHub
 * operation-origin options through this surface.
 */
export interface ForgeIssueOperations<E> {
  readonly getAuthenticatedUserLogin: (
    repository: ForgeRepository,
  ) => Effect.Effect<string, E>
  readonly listReadyIssues: (
    repository: ForgeRepository,
  ) => Effect.Effect<readonly ReadyLabeledIssue[], E>
  readonly ensureIssueCompletedWithSummary: (
    repository: ForgeRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, E>
}

/**
 * Issue operations plus the reconciliation fetch that hides GitHub's
 * list-before-identity credential refresh without changing GitLab/Azure
 * identity-then-list order.
 */
export interface ResolvedForgeIssueOperations<E>
  extends ForgeIssueOperations<E> {
  readonly listReadyIssuesWithAuthorScope: (
    repository: ForgeRepository,
    includeAllIssueAuthors: boolean,
  ) => Effect.Effect<
    {
      readonly remoteIssues: readonly ReadyLabeledIssue[]
      readonly authorScope: IssueAuthorScope
    },
    E
  >
}

/**
 * GitHub still accepts operation-origin options on identity and listing.
 * {@link resolveForgeIssueOperations} binds those options so callers never
 * see them.
 */
export interface ForgeGitHubIssueOperations<E, GitHubOptions = never> {
  readonly getAuthenticatedUserLogin: (
    repository: ForgeRepository,
    options?: GitHubOptions,
  ) => Effect.Effect<string, E>
  readonly listReadyIssues: (
    repository: ForgeRepository,
    options?: GitHubOptions,
  ) => Effect.Effect<readonly ReadyLabeledIssue[], E>
  readonly ensureIssueCompletedWithSummary: (
    repository: ForgeRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, E>
}

export interface ForgeIssueOperationProviders<
  GitHubE,
  GitLabE,
  AzureE,
  GitHubOptions = never,
> {
  readonly github: ForgeGitHubIssueOperations<GitHubE, GitHubOptions>
  readonly gitlab: ForgeIssueOperations<GitLabE>
  readonly azureDevOps: ForgeIssueOperations<AzureE>
}

const withAuthorScope = <E>(
  operations: ForgeIssueOperations<E>,
  listRefreshesCredentials: boolean,
): ResolvedForgeIssueOperations<E> => ({
  ...operations,
  listReadyIssuesWithAuthorScope: (repository, includeAllIssueAuthors) =>
    Effect.gen(function* () {
      if (includeAllIssueAuthors) {
        const remoteIssues = yield* operations.listReadyIssues(repository)
        return { remoteIssues, authorScope: { includeAll: true } as const }
      }
      if (listRefreshesCredentials) {
        const remoteIssues = yield* operations.listReadyIssues(repository)
        const operatorLogin =
          yield* operations.getAuthenticatedUserLogin(repository)
        return {
          remoteIssues,
          authorScope: { includeAll: false as const, operatorLogin },
        }
      }
      const operatorLogin =
        yield* operations.getAuthenticatedUserLogin(repository)
      const remoteIssues = yield* operations.listReadyIssues(repository)
      return {
        remoteIssues,
        authorScope: { includeAll: false as const, operatorLogin },
      }
    }),
})

const bindGitHubOrigin = <E, GitHubOptions>(
  github: ForgeGitHubIssueOperations<E, GitHubOptions>,
  githubOperation: GitHubOptions | undefined,
): ForgeIssueOperations<E> => ({
  getAuthenticatedUserLogin: (repository) =>
    github.getAuthenticatedUserLogin(repository, githubOperation),
  listReadyIssues: (repository) =>
    github.listReadyIssues(repository, githubOperation),
  ensureIssueCompletedWithSummary: (
    repository,
    issueNumber,
    workItemId,
    summaryMarkdown,
  ) =>
    github.ensureIssueCompletedWithSummary(
      repository,
      issueNumber,
      workItemId,
      summaryMarkdown,
    ),
})

/**
 * Resolve the Repository's existing Forge to the shared Issue-operation
 * interface. GitHub origin is bound here; listing order for author scope is
 * GitHub list-then-identity, GitLab and Azure DevOps identity-then-list.
 */
export const resolveForgeIssueOperations = <
  GitHubE,
  GitLabE,
  AzureE,
  GitHubOptions = never,
>(
  forge: Forge,
  providers: ForgeIssueOperationProviders<
    GitHubE,
    GitLabE,
    AzureE,
    GitHubOptions
  >,
  githubOperation?: GitHubOptions,
): ResolvedForgeIssueOperations<GitHubE | GitLabE | AzureE> => {
  switch (forge) {
    case "github":
      return withAuthorScope(
        bindGitHubOrigin(providers.github, githubOperation),
        true,
      )
    case "gitlab":
      return withAuthorScope(providers.gitlab, false)
    case "azure-devops":
      return withAuthorScope(providers.azureDevOps, false)
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}
