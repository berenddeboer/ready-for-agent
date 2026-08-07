import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import {
  type WorkItem,
  WorkItemLifecycleStatus,
} from "../src/home-page-content.js"
import { describe, expect, test } from "bun:test"

const waitingForGitHubWorkItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: "repo-1",
  issueNumber: 874,
  issueTitle: "Model Postponed Step Runs and Waiting for GitHub",
  pullRequestNumber: 42,
  agentBackend: { id: "opencode", label: "OpenCode" },
  state: "WATCH_PR_STATUS_CHECKS",
  stateLabel: "GitHub status checks",
  status: "WAITING_FOR_GITHUB",
  statusLabel: "Waiting for GitHub",
  statusMessage: "Waiting for GitHub until 2026-08-07T12:00:00.000Z",
  postponedUntil: "2026-08-07T12:00:00.000Z",
  paused: false,
  canRetry: false,
  isTerminal: false,
  failureCode: null,
  sessionId: null,
  worktreePath: null,
  completionSummary: null,
  createdAt: "2026-08-07T11:00:00.000Z",
  stateReadyAt: "2026-08-07T11:00:00.000Z",
  lifecycleLabels: [
    {
      phase: "GITHUB_STATUS_CHECKS",
      label: "GitHub status checks: Postponed",
      status: "POSTPONED",
      durationMs: 0,
    },
  ],
} satisfies WorkItem

describe("WorkItemLifecycleStatus", () => {
  test("renders the GitHub hold, retry deadline, and Postponed history without Retry", () => {
    const queryClient = new QueryClient()
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkItemLifecycleStatus workItem={waitingForGitHubWorkItem} compact />
      </QueryClientProvider>,
    )

    expect(html).toContain("Waiting for GitHub")
    expect(html).toContain("Waiting for GitHub until 2026-08-07T12:00:00.000Z")
    expect(html).toContain("GitHub status checks: Postponed")
    expect(html).not.toContain(">Retry<")
  })
})
