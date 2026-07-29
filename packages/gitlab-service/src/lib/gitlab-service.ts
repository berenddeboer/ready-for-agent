import { Context, type Effect } from "effect"
import type {
  GitLabProjectUnavailableError,
  GitLabRequestError,
} from "./errors.js"
import type { GitLabReadyLabeledIssue, GitLabRepository } from "./types.js"

export type GitLabServiceError =
  | GitLabProjectUnavailableError
  | GitLabRequestError

export interface GitLabServiceShape {
  /** Verify Forge Host + Project Path against GitLab before persistence. */
  readonly verifyProject: (
    repository: GitLabRepository,
  ) => Effect.Effect<void, GitLabServiceError>
  /** Operator Forge User for the active ambient credential. */
  readonly getAuthenticatedUserLogin: (
    repository: GitLabRepository,
  ) => Effect.Effect<string, GitLabServiceError>
  /** Open Ready-labeled Issues mapped to the shared Forge issue domain. */
  readonly listReadyIssues: (
    repository: GitLabRepository,
  ) => Effect.Effect<readonly GitLabReadyLabeledIssue[], GitLabServiceError>
  /** Whether ambient GitLab authentication resolves for this Forge Host. */
  readonly hasCredentials: (
    repository: GitLabRepository,
  ) => Effect.Effect<boolean, GitLabRequestError>
}

export class GitLabService extends Context.Service<
  GitLabService,
  GitLabServiceShape
>()("@ready-for-agent/gitlab-service/GitLabService") {}
