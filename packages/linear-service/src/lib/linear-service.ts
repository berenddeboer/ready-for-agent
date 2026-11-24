import { Context, type Effect } from "effect"
import type {
  PublishedSpecFollowUps,
  SpecBaselineReadOptions,
  SpecBaselineResult,
  SpecCloseGuard,
  SpecCloseResult,
  SpecFollowUpPublication,
} from "@ready-for-agent/forge-contract"
import type { LinearRequestError } from "./errors.js"
import type {
  LinearIssueSnapshot,
  LinearProject,
  LinearReadyLabeledIssue,
  LinearSpecObservation,
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
  /**
   * Scheduling observations for open issues marked `spec` in the project.
   * Descendant closure is read from Linear, not inferred from agent intake.
   * Supported for single-team hierarchies fully visible to the configured
   * credential. Linear can omit issues the credential cannot see; this read
   * does not verify access beyond the returned hierarchy. Read errors and
   * incomplete pagination cannot establish readiness.
   * Closure (including cancellation) does not establish delivery.
   */
  readonly observeSpecs: (
    projectId: string,
  ) => Effect.Effect<readonly LinearSpecObservation[], LinearServiceError>
  readonly readSpecBaseline: (
    nativeId: string,
    options?: SpecBaselineReadOptions,
  ) => Effect.Effect<SpecBaselineResult, LinearServiceError>
  readonly publishSpecFollowUps: (
    projectId: string,
    input: SpecFollowUpPublication,
  ) => Effect.Effect<PublishedSpecFollowUps, LinearServiceError>
  /** Close a marked parent only while its validated hierarchy is still current. */
  readonly closePassingSpec?: (input: {
    readonly nativeId: string
    readonly doneStateId: string
    readonly verdictId: string
    readonly summary: string
    readonly guard: SpecCloseGuard
  }) => Effect.Effect<SpecCloseResult, LinearServiceError>
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
