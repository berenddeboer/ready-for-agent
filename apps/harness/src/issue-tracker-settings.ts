import {
  type Forge,
  describeIssueTracker,
  isIssueTracker,
} from "@ready-for-agent/lifecycle-model"

/** Whether the selected Issue Tracker maps a Linear project in settings. */
export const usesLinearProjectMapping = (issueTracker: string): boolean =>
  isIssueTracker(issueTracker) &&
  describeIssueTracker(issueTracker).settings.kind === "linear_project_mapping"

/**
 * Whether a Repository hosted on this Forge may keep this Issue Tracker in
 * its own right rather than as the hosting Forge's tracker.
 */
export const isTrackerOnlyKindSelectableFor = (
  forge: Forge,
  issueTracker: string,
): boolean => {
  if (!isIssueTracker(issueTracker)) {
    return false
  }
  const availability = describeIssueTracker(issueTracker).availability
  return availability.kind === "forges" && availability.forges.includes(forge)
}

/**
 * Whether a parent Issue shows Implement All for this Issue Tracker. A kind
 * without that behaviour hides it rather than offering an action the server
 * refuses or does not have; an unrecognized tracker keeps the action, as
 * before.
 */
export const offersParentImplementAll = (issueTracker: string): boolean => {
  if (!isIssueTracker(issueTracker)) {
    return true
  }
  const implementAll = describeIssueTracker(issueTracker).parentImplementAll
  switch (implementAll.kind) {
    case "available":
      return true
    case "unavailable":
    case "not_implemented":
      return false
    default: {
      const _exhaustive: never = implementAll
      return _exhaustive
    }
  }
}
