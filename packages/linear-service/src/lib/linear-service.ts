import { Context, type Effect } from "effect"
import type { LinearRequestError } from "./errors.js"
import type {
  LinearIssueSnapshot,
  LinearProject,
  LinearReadyLabeledIssue,
  LinearTeamWorkflow,
} from "./types.js"

export type LinearServiceError = LinearRequestError

export interface LinearServiceShape {
  /** Linear viewer id of the authenticated personal API key. */
  readonly getAuthenticatedUserLogin: () => Effect.Effect<
    string,
    LinearServiceError
  >
  /**
   * Open Ready-labeled Issues in one Linear project, including native
   * identity, display identifier, parent/leaf facts, and blockedBy
   * relations. Readable blockers outside the project are included.
   * Unreadable blockers remain blocking rather than omitted.
   */
  readonly listReadyIssues: (
    projectId: string,
  ) => Effect.Effect<readonly LinearReadyLabeledIssue[], LinearServiceError>
  readonly listProjects: () => Effect.Effect<
    readonly LinearProject[],
    LinearServiceError
  >
  readonly listProjectWorkflow: (
    projectId: string,
  ) => Effect.Effect<readonly LinearTeamWorkflow[], LinearServiceError>
  /** Live Linear Issue identity, team, and workflow state. */
  readonly getIssue: (
    nativeId: string,
  ) => Effect.Effect<LinearIssueSnapshot, LinearServiceError>
  /**
   * Move the Issue to `stateId` when it is still open. Already matching,
   * completed, or canceled Issues are accepted without a second transition.
   */
  readonly updateIssueState: (
    nativeId: string,
    stateId: string,
  ) => Effect.Effect<void, LinearServiceError>
  /**
   * Create or update one milestone comment identified by a markdown-visible
   * unique token. Retries reuse the existing comment instead of duplicating it.
   */
  readonly ensureMilestoneComment: (
    nativeId: string,
    marker: string,
    body: string,
  ) => Effect.Effect<void, LinearServiceError>
  readonly hasCredentials: () => Effect.Effect<boolean>
  readonly hasAmbientCredentials: () => Effect.Effect<boolean>
}

export class LinearService extends Context.Service<
  LinearService,
  LinearServiceShape
>()("@ready-for-agent/linear-service/LinearService") {}
