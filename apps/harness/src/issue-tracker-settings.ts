import {
  describeIssueTracker,
  isIssueTracker,
} from "@ready-for-agent/lifecycle-model"

/** Whether the selected Issue Tracker maps a Linear project in settings. */
export const usesLinearProjectMapping = (issueTracker: string): boolean =>
  isIssueTracker(issueTracker) &&
  describeIssueTracker(issueTracker).settings.kind === "linear_project_mapping"

/**
 * Whether a GitHub-hosted Repository may keep this Issue Tracker in its own
 * right rather than as the hosting Forge's tracker.
 */
export const isTrackerOfferedForGitHub = (issueTracker: string): boolean => {
  if (!isIssueTracker(issueTracker)) {
    return false
  }
  const availability = describeIssueTracker(issueTracker).availability
  return (
    availability.kind === "forges" && availability.forges.includes("github")
  )
}
