import { Context, type Effect } from "effect"
import type {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
import type {
  GitHubRepository,
  PullRequestCheckStatus,
  ReadyLabeledIssue,
} from "./types.js"

export interface GitHubServiceShape {
  readonly listReadyIssues: (
    repository: GitHubRepository,
  ) => Effect.Effect<
    readonly ReadyLabeledIssue[],
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly getPullRequestCheckStatus: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    PullRequestCheckStatus,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly markPullRequestReadyForReview: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    void,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
}

export class GitHubService extends Context.Service<
  GitHubService,
  GitHubServiceShape
>()("@ready-for-agent/github-service/GitHubService") {}
