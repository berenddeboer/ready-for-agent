/**
 * Empty-state copy for a Repository card's relevant-issue list.
 *
 * Issue Tracker is independent of the code Forge. A GitHub Repository can
 * poll Linear, and labelled GitHub issues never appear for that tracker.
 * Spaces inside text parts are part of the sentence.
 */

export type RelevantIssuesGuidancePart =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "code"; readonly key: string; readonly text: string }

const CODE_FORGES = ["github", "gitlab", "azure-devops"] as const

type CodeForge = (typeof CODE_FORGES)[number]

// Same labels as forgeDisplayName on the repository card.
const FORGE_DISPLAY_NAMES: Record<CodeForge, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
}

const READY_FOR_AGENT_LABEL: RelevantIssuesGuidancePart = {
  kind: "code",
  key: "ready-for-agent",
  text: "ready-for-agent",
}

const PARENT_CHILD_RULE =
  " If an issue is a child issue, the parent itself cannot be a child issue too."

const isCodeForge = (value: string): value is CodeForge =>
  CODE_FORGES.some((forge) => forge === value)

const trackerForGuidance = (
  issueTracker: string,
  forge: CodeForge,
): CodeForge | "linear" => {
  if (issueTracker === "linear") return "linear"
  if (isCodeForge(issueTracker)) return issueTracker
  return forge
}

const trackerDisplayName = (tracker: CodeForge | "linear"): string =>
  tracker === "linear" ? "Linear" : FORGE_DISPLAY_NAMES[tracker]

const showUpHere = (
  lead: RelevantIssuesGuidancePart,
): RelevantIssuesGuidancePart[] => [
  lead,
  READY_FOR_AGENT_LABEL,
  {
    kind: "text",
    key: "show-up",
    text: ` for them to show up here.${PARENT_CHILD_RULE}`,
  },
]

/** Sentence shown when a refreshed Repository has no relevant issues. */
export const emptyRelevantIssuesGuidance = ({
  forge,
  issueTracker,
  linearProjectName,
}: {
  readonly forge: CodeForge
  readonly issueTracker: string
  readonly linearProjectName: string | null
}): readonly RelevantIssuesGuidancePart[] => {
  const tracker = trackerForGuidance(issueTracker, forge)
  if (tracker !== "linear") {
    return showUpHere({
      kind: "text",
      key: "lead",
      text: `Label ${trackerDisplayName(tracker)} issues with `,
    })
  }

  const projectName = linearProjectName?.trim() ?? ""
  if (projectName === "") {
    return showUpHere({
      kind: "text",
      key: "lead",
      text: "Label Linear issues in the linked Linear project with ",
    })
  }

  return [
    {
      kind: "text",
      key: "lead",
      text: "Label Linear issues in the linked project ",
    },
    { kind: "code", key: "linked-project", text: projectName },
    { kind: "text", key: "with", text: " with " },
    READY_FOR_AGENT_LABEL,
    {
      kind: "text",
      key: "show-up",
      text: ` for them to show up here.${PARENT_CHILD_RULE}`,
    },
  ]
}

/** Title when Refresh issues is disabled because the tracker is unauthenticated. */
export const refreshIssuesUnauthenticatedTitle = ({
  forge,
  issueTracker,
}: {
  readonly forge: CodeForge
  readonly issueTracker: string
}): string => {
  switch (trackerForGuidance(issueTracker, forge)) {
    case "linear":
      return "Authenticate Linear before refreshing issues"
    case "gitlab":
      return "Authenticate GitLab before refreshing issues"
    case "azure-devops":
      return "Authenticate Azure DevOps before refreshing issues"
    default:
      return "Add a GitHub token before refreshing issues"
  }
}
