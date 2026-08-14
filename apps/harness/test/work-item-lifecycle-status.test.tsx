import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Window } from "happy-dom"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
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
    expect(html).not.toContain("Explicit Work Item Execution Profile")
  })

  test("shows an Explicit Work Item Execution Profile on Work Item detail", () => {
    const profiled = {
      ...waitingForGitHubWorkItem,
      executionProfile: {
        backend: { id: "opencode", label: "OpenCode" },
        buildModel: "big-pickle",
        buildThinkingLevel: "high",
        reviewSameAsBuild: true,
        reviewModel: "big-pickle",
        reviewThinkingLevel: "high",
      },
    } satisfies WorkItem
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WorkItemLifecycleStatus workItem={profiled} />
      </QueryClientProvider>,
    )
    expect(html).toContain("Explicit Work Item Execution Profile")
    expect(html).toContain("Build big-pickle · High")
    expect(html).toContain("Review Same as build")
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

  test("renders identically labeled cause-chain links without a duplicate-key warning", async () => {
    const failedWorkItem = {
      ...waitingForGitHubWorkItem,
      state: "IMPLEMENT",
      stateLabel: "Build",
      status: "FAILED",
      statusLabel: "Failed",
      statusMessage: "Agent timed out",
      postponedUntil: null,
      canRetry: true,
      latestStepRunDetail: {
        code: "TIMEOUT",
        causeChain: [
          {
            name: "TimeoutError",
            code: "TIMEOUT",
            message: null,
          },
          {
            name: "TimeoutError",
            code: "TIMEOUT",
            message: null,
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

    const tree = (
      <QueryClientProvider client={new QueryClient()}>
        <WorkItemLifecycleStatus workItem={failedWorkItem} compact />
      </QueryClientProvider>
    )
    const html = renderToStaticMarkup(tree)
    expect(html).toContain("Cause chain")
    expect(causeChainLabels(html)).toEqual([
      "TimeoutError TIMEOUT",
      "TimeoutError TIMEOUT",
    ])

    const warnings = await renderAndCollectConsoleErrors(tree)
    expect(warnings.join("\n")).not.toMatch(
      /Encountered two children with the same key/,
    )
  })
})

function causeChainLabels(html: string): readonly string[] {
  const section = html.match(/Cause chain<\/summary>([\s\S]*?)<\/details>/)
  if (section === null) {
    return []
  }
  return [...section[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
    (match) => match[1],
  )
}

const INSTALLED_GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "DocumentFragment",
  "SVGElement",
  "navigator",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
] as const

async function renderAndCollectConsoleErrors(
  tree: ReactNode,
): Promise<readonly string[]> {
  const previous = new Map<string, { had: boolean; value: unknown }>()
  const g = globalThis as unknown as Record<string, unknown>
  for (const key of INSTALLED_GLOBAL_KEYS) {
    previous.set(key, { had: Object.hasOwn(g, key), value: g[key] })
  }
  const happyWindow = new Window({ url: "https://localhost/" })
  g.window = happyWindow
  g.document = happyWindow.document
  g.HTMLElement = happyWindow.HTMLElement
  g.Element = happyWindow.Element
  g.Node = happyWindow.Node
  g.DocumentFragment = happyWindow.DocumentFragment
  g.SVGElement = happyWindow.SVGElement
  g.navigator = happyWindow.navigator
  g.getComputedStyle = happyWindow.getComputedStyle.bind(happyWindow)
  g.IS_REACT_ACT_ENVIRONMENT = false

  const container = happyWindow.document.createElement("div")
  happyWindow.document.body.appendChild(container)
  const warnings: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  const root = createRoot(container as unknown as HTMLElement)
  try {
    flushSync(() => {
      root.render(tree)
    })
    return warnings
  } finally {
    flushSync(() => {
      root.unmount()
    })
    // React may schedule a NormalPriority callback that reads `window.event`.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    console.error = originalError
    happyWindow.close()
    for (const [key, entry] of previous) {
      if (entry.had) {
        g[key] = entry.value
      } else {
        delete g[key]
      }
    }
  }
}
