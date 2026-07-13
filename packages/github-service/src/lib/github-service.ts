import { Context, type Effect } from "effect"
import type {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
import type { GitHubRepository, ReadyLabeledIssue } from "./types.js"

export interface GitHubServiceShape {
  readonly listReadyIssues: (
    repository: GitHubRepository,
  ) => Effect.Effect<
    readonly ReadyLabeledIssue[],
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
}

export class GitHubService extends Context.Tag(
  "@ready-for-agent/github-service/GitHubService",
)<GitHubService, GitHubServiceShape>() {}
