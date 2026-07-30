// This file is generated from ontology/rfa.ttl.
// Run `bunx nx run lifecycle-model:generate` to update it.

import { Schema } from "effect"

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
