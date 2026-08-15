// This file is generated from ontology/rfa.ttl.
// Run `bunx nx run lifecycle-model:generate` to update it.

import { Duration, Schema } from "effect"

export const OPERATIONAL_LIFECYCLE_STEPS = [
  "assess_changes",
  "close_issue",
  "commit",
  "create_pr",
  "create_worktree",
  "decide_pr_merge",
  "implement",
  "install_dependencies",
  "investigate_pr_status_checks",
  "local_cleanup",
  "mark_pr_ready_for_review",
  "merge_pr",
  "pre_commit",
  "resolve_pr_merge_conflict",
  "review",
  "watch_pr_status_checks",
] as const

export const OperationalLifecycleStep = Schema.Literals(
  OPERATIONAL_LIFECYCLE_STEPS,
)
export type OperationalLifecycleStep =
  typeof OperationalLifecycleStep.Type

export const TERMINAL_WORK_ITEM_STATES = [
  "abandoned",
  "complete",
  "failed",
  "needs_human",
] as const

export const TerminalWorkItemState = Schema.Literals(
  TERMINAL_WORK_ITEM_STATES,
)
export type TerminalWorkItemState = typeof TerminalWorkItemState.Type

export const WORK_ITEM_STATES = [
  ...OPERATIONAL_LIFECYCLE_STEPS,
  ...TERMINAL_WORK_ITEM_STATES,
] as const

export const WorkItemState = Schema.Literals(WORK_ITEM_STATES)
export type WorkItemState = typeof WorkItemState.Type

export type LifecycleStepPropertyMap<Value> = {
  readonly [Step in OperationalLifecycleStep]: Value
}

export const LIFECYCLE_STEP_AGENT_FREE = {
  assess_changes: false,
  close_issue: true,
  commit: false,
  create_pr: false,
  create_worktree: true,
  decide_pr_merge: false,
  implement: false,
  install_dependencies: false,
  investigate_pr_status_checks: false,
  local_cleanup: true,
  mark_pr_ready_for_review: true,
  merge_pr: true,
  pre_commit: false,
  resolve_pr_merge_conflict: false,
  review: false,
  watch_pr_status_checks: true,
} as const satisfies LifecycleStepPropertyMap<boolean>

export type LifecycleMaxDurations =
  LifecycleStepPropertyMap<Duration.Duration>

export const DEFAULT_LIFECYCLE_MAX_DURATIONS = {
  assess_changes: Duration.millis(3600000),
  close_issue: Duration.millis(300000),
  commit: Duration.millis(1800000),
  create_pr: Duration.millis(600000),
  create_worktree: Duration.millis(300000),
  decide_pr_merge: Duration.millis(900000),
  implement: Duration.millis(7200000),
  install_dependencies: Duration.millis(900000),
  investigate_pr_status_checks: Duration.millis(7200000),
  local_cleanup: Duration.millis(300000),
  mark_pr_ready_for_review: Duration.millis(300000),
  merge_pr: Duration.millis(300000),
  pre_commit: Duration.millis(7200000),
  resolve_pr_merge_conflict: Duration.millis(7200000),
  review: Duration.millis(3600000),
  watch_pr_status_checks: Duration.millis(300000),
} satisfies LifecycleMaxDurations

export const LIFECYCLE_STEP_RETRYABLE = {
  assess_changes: true,
  close_issue: true,
  commit: true,
  create_pr: true,
  create_worktree: true,
  decide_pr_merge: true,
  implement: true,
  install_dependencies: true,
  investigate_pr_status_checks: true,
  local_cleanup: true,
  mark_pr_ready_for_review: true,
  merge_pr: true,
  pre_commit: true,
  resolve_pr_merge_conflict: true,
  review: true,
  watch_pr_status_checks: true,
} as const satisfies LifecycleStepPropertyMap<boolean>

export const isAgentFreeLifecycleStep = (step: string): boolean =>
  Object.hasOwn(LIFECYCLE_STEP_AGENT_FREE, step) &&
  LIFECYCLE_STEP_AGENT_FREE[step as OperationalLifecycleStep]

export const isAgentDependentLifecycleStep = (step: string): boolean =>
  !isAgentFreeLifecycleStep(step)

export interface LifecycleTransition {
  readonly from: WorkItemState
  readonly to: WorkItemState
  readonly guard: string
  readonly reasonCode: string
}

export const LIFECYCLE_TRANSITIONS = [
  {
    from: "assess_changes",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "assess_changes",
    to: "close_issue",
    guard: "no_change_outcome",
    reasonCode: "native",
  },
  {
    from: "assess_changes",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "assess_changes",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "assess_changes",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "assess_changes",
    to: "pre_commit",
    guard: "changes_detected",
    reasonCode: "native",
  },
  {
    from: "close_issue",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "close_issue",
    to: "failed",
    guard: "close_issue_eligibility_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "close_issue",
    to: "local_cleanup",
    guard: "issue_closed",
    reasonCode: "native",
  },
  {
    from: "close_issue",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "close_issue",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "commit",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "commit",
    to: "create_pr",
    guard: "agent_fallback_completion",
    reasonCode: "agent_fallback",
  },
  {
    from: "commit",
    to: "create_pr",
    guard: "native_completion",
    reasonCode: "native",
  },
  {
    from: "commit",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "commit",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "commit",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "create_pr",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "create_pr",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "create_pr",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "create_pr",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "create_pr",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "create_pr",
    to: "watch_pr_status_checks",
    guard: "agent_fallback_completion",
    reasonCode: "agent_fallback",
  },
  {
    from: "create_pr",
    to: "watch_pr_status_checks",
    guard: "native_completion",
    reasonCode: "native",
  },
  {
    from: "create_worktree",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "create_worktree",
    to: "failed",
    guard: "blocked_issue_became_invalid",
    reasonCode: "handler_failed",
  },
  {
    from: "create_worktree",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "create_worktree",
    to: "install_dependencies",
    guard: "step_succeeded",
    reasonCode: "native",
  },
  {
    from: "create_worktree",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "create_worktree",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "decide_pr_merge",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "decide_pr_merge",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "decide_pr_merge",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "decide_pr_merge",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "decide_pr_merge",
    to: "merge_pr",
    guard: "always_merge_mode_defensive_route",
    reasonCode: "native",
  },
  {
    from: "decide_pr_merge",
    to: "merge_pr",
    guard: "clanker_merge_decision",
    reasonCode: "native",
  },
  {
    from: "decide_pr_merge",
    to: "needs_human",
    guard: "human_merge_decision",
    reasonCode: "handler_failed",
  },
  {
    from: "decide_pr_merge",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "failed",
    to: "watch_pr_status_checks",
    guard: "retry_unresolved_status_checks",
    reasonCode: "pr_status_checks_unresolved",
  },
  {
    from: "implement",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "implement",
    to: "assess_changes",
    guard: "step_succeeded",
    reasonCode: "native",
  },
  {
    from: "implement",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "implement",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "implement",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "install_dependencies",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "install_dependencies",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "install_dependencies",
    to: "implement",
    guard: "step_succeeded",
    reasonCode: "native",
  },
  {
    from: "install_dependencies",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "install_dependencies",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "investigate_pr_status_checks",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "investigate_pr_status_checks",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "investigate_pr_status_checks",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "investigate_pr_status_checks",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "investigate_pr_status_checks",
    to: "needs_human",
    guard: "handoff_needs_human",
    reasonCode: "handler_failed",
  },
  {
    from: "investigate_pr_status_checks",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "investigate_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "green_without_review_evidence",
    reasonCode: "green-no-review-evidence",
  },
  {
    from: "investigate_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "handoff_processed",
    reasonCode: "native",
  },
  {
    from: "investigate_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "replacement_checks_triggered",
    reasonCode: "native",
  },
  {
    from: "local_cleanup",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "local_cleanup",
    to: "complete",
    guard: "local_cleanup_succeeded",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "decide_pr_merge",
    guard: "settled_non_failing_ordinary_merge_mode",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "investigate_pr_status_checks",
    guard: "reobserved_status_check_handoff",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "merge_pr",
    guard: "settled_non_failing_successful_always_merge_mode",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "needs_human",
    guard: "autonomous_merge_without_successful_checks",
    reasonCode: "missing_successful_checks",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "needs_human",
    guard: "reobserved_closed_pull_request",
    reasonCode: "handler_failed",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "resolve_pr_merge_conflict",
    guard: "reobserved_merge_conflict",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "watch_pr_status_checks",
    guard: "failed_or_pending_ready_phase_checks",
    reasonCode: "native",
  },
  {
    from: "mark_pr_ready_for_review",
    to: "watch_pr_status_checks",
    guard: "ready_phase_wait_enabled",
    reasonCode: "native",
  },
  {
    from: "merge_pr",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "merge_pr",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "merge_pr",
    to: "local_cleanup",
    guard: "owned_pull_request_merge_observed_at_revalidation",
    reasonCode: "pr_merged",
  },
  {
    from: "merge_pr",
    to: "local_cleanup",
    guard: "pull_request_merged",
    reasonCode: "native",
  },
  {
    from: "merge_pr",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "merge_pr",
    to: "needs_human",
    guard: "autonomous_merge_without_successful_checks",
    reasonCode: "missing_successful_checks",
  },
  {
    from: "merge_pr",
    to: "needs_human",
    guard: "merge_needs_human",
    reasonCode: "handler_failed",
  },
  {
    from: "merge_pr",
    to: "needs_human",
    guard: "merge_revalidation_limit_exhausted",
    reasonCode: "merge_revalidation",
  },
  {
    from: "merge_pr",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "merge_pr",
    to: "watch_pr_status_checks",
    guard: "merge_revalidation_within_limit",
    reasonCode: "merge_revalidation",
  },
  {
    from: "needs_human",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "needs_human",
    to: "investigate_pr_status_checks",
    guard: "retry_status_check_handoff",
    reasonCode: "handler_failed",
  },
  {
    from: "needs_human",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "needs_human",
    to: "resolve_pr_merge_conflict",
    guard: "refresh_observed_merge_conflict",
    reasonCode: "native",
  },
  {
    from: "needs_human",
    to: "review",
    guard: "retry_review_fix_limit",
    reasonCode: "handler_failed",
  },
  {
    from: "needs_human",
    to: "watch_pr_status_checks",
    guard: "refresh_observed_merge_conflict_cleared",
    reasonCode: "native",
  },
  {
    from: "needs_human",
    to: "watch_pr_status_checks",
    guard: "retry_missing_successful_checks",
    reasonCode: "missing_successful_checks",
  },
  {
    from: "pre_commit",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "pre_commit",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "pre_commit",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "pre_commit",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "pre_commit",
    to: "review",
    guard: "step_succeeded",
    reasonCode: "native",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "needs_human",
    guard: "conflict_needs_human",
    reasonCode: "handler_failed",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "resolve_pr_merge_conflict",
    to: "watch_pr_status_checks",
    guard: "conflict_processed",
    reasonCode: "native",
  },
  {
    from: "review",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "review",
    to: "commit",
    guard: "review_accepted",
    reasonCode: "review_accepted",
  },
  {
    from: "review",
    to: "commit",
    guard: "review_cleared",
    reasonCode: "review_cleared",
  },
  {
    from: "review",
    to: "commit",
    guard: "review_completed",
    reasonCode: "native",
  },
  {
    from: "review",
    to: "commit",
    guard: "review_deferred",
    reasonCode: "review_deferred",
  },
  {
    from: "review",
    to: "failed",
    guard: "issue_revalidation_failed",
    reasonCode: "handler_failed",
  },
  {
    from: "review",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "review",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "review",
    to: "needs_human",
    guard: "review_needs_human",
    reasonCode: "handler_failed",
  },
  {
    from: "watch_pr_status_checks",
    to: "abandoned",
    guard: "operator_abandon",
    reasonCode: "abandoned",
  },
  {
    from: "watch_pr_status_checks",
    to: "decide_pr_merge",
    guard: "fallback_ready_ordinary_merge_mode",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "decide_pr_merge",
    guard: "settled_ready_ordinary_merge_mode",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "failed",
    guard: "issue_revalidation_failed_without_owned_pr_stop",
    reasonCode: "handler_failed",
  },
  {
    from: "watch_pr_status_checks",
    to: "investigate_pr_status_checks",
    guard: "status_check_handoff_needed",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "local_cleanup",
    guard: "owned_pull_request_merged",
    reasonCode: "pr_merged",
  },
  {
    from: "watch_pr_status_checks",
    to: "local_cleanup",
    guard: "refresh_observed_merged_work_item_pr",
    reasonCode: "pr_merged",
  },
  {
    from: "watch_pr_status_checks",
    to: "mark_pr_ready_for_review",
    guard: "failed_checks_on_draft",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "mark_pr_ready_for_review",
    guard: "fallback_draft_observation",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "mark_pr_ready_for_review",
    guard: "settled_draft",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "merge_pr",
    guard: "fallback_ready_successful_always_merge_mode",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "merge_pr",
    guard: "settled_ready_successful_always_merge_mode",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "needs_human",
    guard: "autonomous_merge_without_successful_checks",
    reasonCode: "missing_successful_checks",
  },
  {
    from: "watch_pr_status_checks",
    to: "needs_human",
    guard: "pull_request_closed",
    reasonCode: "handler_failed",
  },
  {
    from: "watch_pr_status_checks",
    to: "needs_human",
    guard: "refresh_observed_unowned_issue_closing_pull_request",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "resolve_pr_merge_conflict",
    guard: "merge_conflict_observed",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "checks_pending",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "failed_checks_before_deadline_or_unknown_draft_state",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "fallback_unknown_draft_state",
    reasonCode: "native",
  },
  {
    from: "watch_pr_status_checks",
    to: "watch_pr_status_checks",
    guard: "settled_with_unknown_draft_state",
    reasonCode: "native",
  },
] as const satisfies readonly LifecycleTransition[]

export const isDeclaredLifecycleTransition = (
  from: WorkItemState,
  to: WorkItemState,
): boolean =>
  LIFECYCLE_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to,
  )

