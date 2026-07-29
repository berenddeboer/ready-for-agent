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
  /**
   * Whether credentials resolve for this Repository: a per-Repository vault
   * secret and/or ambient `GITLAB_TOKEN` / `glab` (layer-dependent).
   */
  readonly hasCredentials: (
    repository: GitLabRepository,
  ) => Effect.Effect<boolean, GitLabRequestError>
  /**
   * Whether ambient credentials resolve, ignoring Keymaxxer vault.
   * Callers that already paid for a vault metadata probe (miss or timeout)
   * use this so ambient-only Repositories are not blocked by a second vault RPC.
   * Ambient-only layers implement this the same as hasCredentials.
   */
  readonly hasAmbientCredentials: (
    repository: GitLabRepository,
  ) => Effect.Effect<boolean, GitLabRequestError>
}

export class GitLabService extends Context.Service<
  GitLabService,
  GitLabServiceShape
>()("@ready-for-agent/gitlab-service/GitLabService") {}
