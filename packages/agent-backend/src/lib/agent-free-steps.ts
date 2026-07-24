/**
 * Central classification of Lifecycle Steps as Agent-free (guaranteed not to
 * invoke an Agent Turn) vs agent-dependent (always or conditionally may).
 *
 * While the Active Agent Backend is unavailable or restart-required, only
 * Agent-free steps may start.
 */

const AGENT_FREE_STEPS = new Set<string>([
  "create_worktree",
  "watch_pr_status_checks",
  "mark_pr_ready_for_review",
  "merge_pr",
  "close_issue",
  "local_cleanup",
])

export const isAgentFreeLifecycleStep = (step: string): boolean =>
  AGENT_FREE_STEPS.has(step)

export const isAgentDependentLifecycleStep = (step: string): boolean =>
  !isAgentFreeLifecycleStep(step)
