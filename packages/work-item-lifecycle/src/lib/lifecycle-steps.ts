import { Context, type Duration, type Effect } from "effect"
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
  readonly worktreePath: string | null
  readonly sessionId: string | null
  readonly maxDuration?: Duration.Duration
}

/**
 * Injected step handlers. Production adapters and tests both implement this
 * surface; the lifecycle module selects the handler from the pending step.
 */
export interface LifecycleStepsShape {
  readonly createWorktree: (
    context: LifecycleStepContext,
  ) => Effect.Effect<string, unknown>
  readonly installDependencies: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, unknown>
  readonly implement: (
    context: LifecycleStepContext,
  ) => Effect.Effect<string, unknown>
  readonly preCommit: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, unknown>
  readonly review: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, unknown>
  readonly removeWorktree: (
    context: LifecycleStepContext,
  ) => Effect.Effect<void, unknown>
}

export class LifecycleSteps extends Context.Service<
  LifecycleSteps,
  LifecycleStepsShape
>()("@ready-for-agent/work-item-lifecycle/LifecycleSteps") {}
