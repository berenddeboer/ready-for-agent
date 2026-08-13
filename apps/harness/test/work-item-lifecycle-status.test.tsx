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
  stateLabel: "Status checks",
  status: "WAITING_FOR_GITHUB",
  statusLabel: "Waiting for GitHub",
  statusMessage: "Waiting for GitHub until 2026-08-07T12:00:00.000Z",
  latestStepRunDetail: null,
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
      label: "Status checks: Postponed",
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
    expect(html).toContain("Status checks: Postponed")
    expect(html).not.toContain(">Retry<")
    expect(html).not.toContain("Cause chain")
  })

  test("hides the cause chain behind a collapsed disclosure on a failed card", () => {
    const failedWorkItem = {
      ...waitingForGitHubWorkItem,
      state: "IMPLEMENT",
      stateLabel: "Build",
      status: "FAILED",
      statusLabel: "Failed",
      statusMessage: 'Executable not found in $PATH: "claude"',
      postponedUntil: null,
      canRetry: true,
      latestStepRunDetail: {
        code: "ENOENT",
        causeChain: [
          {
            name: "Error",
            code: "ENOENT",
            message: 'ENOENT: Executable not found in $PATH: "claude"',
          },
        ],
      },
      lifecycleLabels: [
        {
          phase: "IMPLEMENT",
          label: "Build: Failed",
          status: "FAILED",
          durationMs: 1200,
        },
      ],
    } satisfies WorkItem

    const queryClient = new QueryClient()
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkItemLifecycleStatus workItem={failedWorkItem} compact />
      </QueryClientProvider>,
    )

    expect(html).toContain("Executable not found in $PATH: &quot;claude&quot;")
    expect(html).toContain("Cause chain")
    expect(html).toContain("<details")
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    expect(html).toContain("Error ENOENT")
    expect(html).toContain("Code: ENOENT")
  })
})
