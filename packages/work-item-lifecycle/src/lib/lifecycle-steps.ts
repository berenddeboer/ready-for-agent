import { Context, type Duration, type Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type {
  DatabaseError,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import type {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "@ready-for-agent/github-service"
import type { KeymaxxerError } from "@ready-for-agent/keymaxxer-service"
import type { AssessChangesResult } from "./assess-changes.js"
import type { AssessChangesError } from "./assess-changes-errors.js"
import type { CloseIssueError } from "./close-issue-errors.js"
import type { CommitError } from "./commit-errors.js"
import type { CreatePrError } from "./create-pr-errors.js"
import type { CreateWorktreeError } from "./create-worktree-errors.js"
import type {
  DecidePrMergeContextError,
  DecidePrMergeOpenCodeError,
  DecidePrMergeResult,
} from "./decide-pr-merge.js"
import type {
  LifecycleStepFailedError,
  WorkItemLifecycleDatabaseError,
} from "./errors.js"
import type { ImplementError } from "./implement-errors.js"
import type { InstallDependenciesError } from "./install-dependencies-errors.js"
import type { MarkPrReadyForReviewContextError } from "./mark-pr-ready-for-review.js"
import type { MergePrContextError } from "./merge-pr.js"
import type {
  PrStatusCheckInvestigationResult,
  PrStatusCheckResult,
  PrStatusChecksContextError,
  PrStatusChecksOpenCodeError,
} from "./pr-status-checks.js"
import type { PreCommitError } from "./pre-commit-errors.js"
import type { RemoveWorktreeError } from "./remove-worktree.js"
import type {
  ResolvePrMergeConflictContextError,
  ResolvePrMergeConflictOpenCodeError,
  ResolvePrMergeConflictResult,
} from "./resolve-pr-merge-conflict.js"
import type { ReviewError } from "./review-errors.js"
import type { WorkItemId } from "./types.js"

/**
 * Context supplied to every Lifecycle Step handler.
 * Later steps receive worktree/session fields persisted by earlier successes.
 */
export interface LifecycleStepContext {
  readonly workItemId: WorkItemId
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly model: string
  readonly variant: string
  readonly reviewModel: string
  readonly reviewVariant: string
  readonly worktreePath: string | null
  readonly startingCommitOid: string | null
  readonly completionSummary: string | null
  readonly sessionId: string | null
  readonly maxDuration?: Duration.Duration
}

/** Result of a successful Create Worktree Step Run. */
export type CreateWorktreeResult = {
  readonly worktreePath: string
  readonly startingCommitOid: string
}

/**
 * Typed failures a Lifecycle Step handler may surface to the orchestrator.
 * Domain step errors plus platform/service errors that production handlers
 * currently leave unmapped.
 */
export type LifecycleStepError =
  | CreateWorktreeError
  | InstallDependenciesError
  | ImplementError
  | AssessChangesError
  | PreCommitError
  | ReviewError
  | CommitError
  | CreatePrError
  | CloseIssueError
  | RemoveWorktreeError
  | DecidePrMergeContextError
  | DecidePrMergeOpenCodeError
  | PrStatusChecksContextError
  | PrStatusChecksOpenCodeError
  | ResolvePrMergeConflictContextError
  | ResolvePrMergeConflictOpenCodeError
  | MarkPrReadyForReviewContextError
  | MergePrContextError
  | LifecycleStepFailedError
  | DatabaseError
  | RepositoryNotFoundError
  | GitHubRequestError
  | GitHubRepositoryUnavailableError
  | KeymaxxerError
  | PlatformError
  | SqlError

/** Errors runHandler may surface, including orchestrator DB reads mid-handler. */
export type RunHandlerError =
  | LifecycleStepError
  | WorkItemLifecycleDatabaseError

/**
 * Injected step handlers. Production adapters and tests both implement this
 * surface; the lifecycle module selects the handler from the pending step.
 */
export interface LifecycleStepsShape {
  readonly createWorktree: (
    context: LifecycleStepContext,
  ) => Effect.Effect<CreateWorktreeResult, LifecycleStepError>
  readonly installDependencies: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly implement: (
    context: LifecycleStepContext,
  ) => Effect.Effect<string, LifecycleStepError>
  readonly assessChanges: (
    context: LifecycleStepContext,
  ) => Effect.Effect<AssessChangesResult, LifecycleStepError>
  readonly preCommit: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly review: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly commit: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly createPr: (
    context: LifecycleStepContext,
  ) => Effect.Effect<number, LifecycleStepError>
  readonly watchPrStatusChecks: (
    context: LifecycleStepContext,
  ) => Effect.Effect<PrStatusCheckResult, LifecycleStepError>
  readonly resolvePrMergeConflict: (
    context: LifecycleStepContext,
  ) => Effect.Effect<ResolvePrMergeConflictResult, LifecycleStepError>
  readonly investigatePrStatusChecks: (
    context: LifecycleStepContext,
  ) => Effect.Effect<PrStatusCheckInvestigationResult, LifecycleStepError>
  readonly markPrReadyForReview: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly decidePrMerge: (
    context: LifecycleStepContext,
  ) => Effect.Effect<DecidePrMergeResult, LifecycleStepError>
  readonly mergePr: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly closeIssue: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly localCleanup: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
  readonly removeWorktree: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, LifecycleStepError>
}

export class LifecycleSteps extends Context.Service<
  LifecycleSteps,
  LifecycleStepsShape
>()("@ready-for-agent/work-item-lifecycle/LifecycleSteps") {}
