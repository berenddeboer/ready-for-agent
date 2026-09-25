import {
  type AfterConfirmedMerge,
  type IssueSource,
  behaviourNotImplemented,
  describeIssueTracker,
} from "@ready-for-agent/lifecycle-model"

/**
 * What follows a confirmed merge, as the Original Issue Source's Issue
 * Tracker description decides. A context without a source keeps local
 * cleanup.
 */
export const afterConfirmedMerge = (
  source: IssueSource | undefined,
): AfterConfirmedMerge => {
  if (source === undefined) {
    return { kind: "local_cleanup" }
  }
  const next = describeIssueTracker(source.tracker).afterConfirmedMerge
  switch (next.kind) {
    case "local_cleanup":
    case "close_issue":
      return next
    case "not_implemented":
      return behaviourNotImplemented(
        source.tracker,
        "step after a confirmed merge",
      )
    default: {
      const _exhaustive: never = next
      return _exhaustive
    }
  }
}

export const nextStateAfterConfirmedMerge = (
  source: IssueSource | undefined,
): AfterConfirmedMerge["kind"] => afterConfirmedMerge(source).kind

/**
 * Completion summary for Close Issue after a confirmed merge: the persisted
 * summary when there is one, else the tracker's own.
 */
export const mergeCompletionSummary = (
  next: Extract<AfterConfirmedMerge, { readonly kind: "close_issue" }>,
  existing: string | null | undefined,
): string => {
  const persisted = existing?.trim()
  if (persisted !== undefined && persisted !== "") {
    return persisted
  }
  return next.completionSummary
}
