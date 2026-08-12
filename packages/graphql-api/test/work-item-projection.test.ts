import type { WorkItemRecord } from "@ready-for-agent/work-item-lifecycle"
import {
  cumulativeExecutionDurationMs,
  lifecycleLabels,
  statusLabel,
  workItemCanRetry,
  workItemPostponedUntil,
  workItemStatus,
  workItemStatusMessage,
} from "../src/lib/work-item-projection.js"
import { describe, expect, test } from "bun:test"

const baseStepRun = {
  id: "srun-01J00000000000000000000000",
  workItemId: "wi-01J00000000000000000000000",
  step: "review" as const,
  status: "succeeded" as const,
  queueJobId: null,
  queuedAt: new Date("2026-07-14T08:00:00.000Z"),
  startedAt: new Date("2026-07-14T08:00:01.000Z"),
  finishedAt: new Date("2026-07-14T08:38:36.000Z"),
  reasonCode: null,
  reasonMessage: null,
  postponedUntil: null,
  queueWaitMs: 1_000,
  executionDurationMs: 2_315_000, // 38m 35s
}

const baseWorkItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: "repo-1",
  issueNumber: 42,
  issueTitle: "Example",
  agentBackend: "opencode",
  state: "review",
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  paused: false,
  waitingSince: null,
  waitingForBlockers: false,
  mergeMode: "ordinary",
  holdsWorkerSlot: true,
  pauseBeforeStep: null,
  worktreePath: null,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: null,
  pullRequestNumber: null,
  failureCode: null,
  failureMessage: null,
  createdAt: new Date("2026-07-14T08:00:00.000Z"),
  updatedAt: new Date("2026-07-14T08:38:36.000Z"),
  stateResidenceMs: 0,
  stepRuns: [baseStepRun],
} as WorkItemRecord

const workItemWith = (overrides: Partial<WorkItemRecord>): WorkItemRecord => ({
  ...baseWorkItem,
  ...overrides,
})

describe("cumulativeExecutionDurationMs", () => {
  test("returns null when no attempt has started", () => {
    expect(
      cumulativeExecutionDurationMs([
        { executionDurationMs: null },
        { executionDurationMs: null },
      ]),
    ).toBeNull()
  })

  test("returns a single attempt duration unchanged", () => {
    expect(cumulativeExecutionDurationMs([{ executionDurationMs: 0 }])).toBe(0)
    expect(
      cumulativeExecutionDurationMs([{ executionDurationMs: 2_315_000 }]),
    ).toBe(2_315_000)
  })

  test("sums non-null attempt durations and skips queued nulls", () => {
    expect(
      cumulativeExecutionDurationMs([
        { executionDurationMs: 2_315_000 },
        { executionDurationMs: null }, // queued retry has not started
        { executionDurationMs: 45_000 },
        { executionDurationMs: 12_000 },
      ]),
    ).toBe(2_315_000 + 45_000 + 12_000)
  })
})

describe("Postponed Step Run projection", () => {
  const postponedUntil = new Date("2026-08-07T12:00:00.000Z")
  const postponedStepRun = {
    ...baseStepRun,
    step: "watch_pr_status_checks",
    status: "postponed",
    finishedAt: new Date("2026-08-07T11:00:00.000Z"),
    postponedUntil,
  } satisfies WorkItemRecord["stepRuns"][number]
  const postponed = workItemWith({
    state: "watch_pr_status_checks",
    holdsWorkerSlot: false,
    stepRuns: [postponedStepRun],
  })
  const postponedWorkItemWith = (
    overrides: Partial<WorkItemRecord>,
  ): WorkItemRecord => ({ ...postponed, ...overrides })

  test("derives Waiting for GitHub from latest postponed history and deadline", () => {
    expect(workItemStatus(postponed)).toBe("waiting_for_github")
    expect(statusLabel(workItemStatus(postponed))).toBe("Waiting for GitHub")
    expect(workItemPostponedUntil(postponed)).toEqual(postponedUntil)
    expect(workItemStatusMessage(postponed)).toBe(
      "Waiting for GitHub until 2026-08-07T12:00:00.000Z",
    )
    expect(workItemCanRetry(postponed)).toBe(false)
    expect(lifecycleLabels(postponed)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Postponed",
        status: "POSTPONED",
        durationMs: 2_315_000,
      },
    ])
  })

  test("keeps lifecycle hold precedence without a duplicate persisted flag", () => {
    const paused = postponedWorkItemWith({ paused: true })
    expect(workItemStatus(paused)).toBe("needs_human_review")
    expect(workItemPostponedUntil(paused)).toBeNull()
    expect(workItemStatusMessage(paused)).toBeNull()
    expect(
      workItemStatus(
        postponedWorkItemWith({
          paused: true,
          waitingSince: new Date("2026-08-07T11:30:00.000Z"),
        }),
      ),
    ).toBe("waiting_for_worker_slot")
    expect(
      workItemStatus(
        postponedWorkItemWith({
          waitingSince: new Date("2026-08-07T11:30:00.000Z"),
          waitingForBlockers: true,
        }),
      ),
    ).toBe("waiting_for_blockers")
    expect(workItemStatus(postponedWorkItemWith({ state: "complete" }))).toBe(
      "complete",
    )
  })

  test("does not derive a GitHub hold from contradictory active resources", () => {
    const workerSlotHeld = postponedWorkItemWith({ holdsWorkerSlot: true })
    expect(workItemStatus(workerSlotHeld)).toBe("postponed")
    expect(workItemPostponedUntil(workerSlotHeld)).toBeNull()

    const activeHistory = postponedWorkItemWith({
      stepRuns: [
        {
          ...baseStepRun,
          step: "watch_pr_status_checks",
          status: "running",
          finishedAt: null,
          postponedUntil: null,
        } satisfies WorkItemRecord["stepRuns"][number],
        postponedStepRun,
      ],
    })
    expect(workItemStatus(activeHistory)).toBe("postponed")
    expect(workItemPostponedUntil(activeHistory)).toBeNull()
  })

  test("retains Postponed history after a durable wake starts a fresh attempt", () => {
    const resumed = postponedWorkItemWith({
      stepRuns: [
        postponedStepRun,
        {
          ...baseStepRun,
          id: "srun-01J00000000000000000000001",
          step: "watch_pr_status_checks",
          status: "queued",
          finishedAt: null,
          postponedUntil: null,
          executionDurationMs: null,
        } satisfies WorkItemRecord["stepRuns"][number],
      ],
    })

    expect(lifecycleLabels(resumed)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Postponed (1 prior attempt)",
        status: "POSTPONED",
        durationMs: null,
      },
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Queued",
        status: "QUEUED",
        durationMs: 2_315_000,
      },
    ])
  })
})

describe("lifecycleLabels cumulative duration", () => {
  test("keeps Review duration after Needs Human when retry is running", () => {
    const priorReviewMs = 2_315_000
    const currentAttemptMs = 90_000
    const workItem = {
      ...baseWorkItem,
      state: "review",
      stepRuns: [
        {
          ...baseStepRun,
          id: "srun-review-1",
          status: "succeeded" as const,
          executionDurationMs: priorReviewMs,
          finishedAt: new Date("2026-07-14T08:38:36.000Z"),
        },
        {
          ...baseStepRun,
          id: "srun-review-2",
          status: "running" as const,
          startedAt: new Date("2026-07-14T09:00:00.000Z"),
          finishedAt: null,
          executionDurationMs: currentAttemptMs,
        },
      ],
    } as WorkItemRecord

    const labels = lifecycleLabels(workItem)
    expect(labels).toEqual([
      {
        phase: "REVIEW",
        label: "Review: reviewing",
        status: "RUNNING",
        durationMs: priorReviewMs + currentAttemptMs,
      },
    ])
  })

  test("preserves prior Review duration while a retry is still queued", () => {
    const priorReviewMs = 2_315_000
    const workItem = {
      ...baseWorkItem,
      state: "needs_human",
      stepRuns: [
        {
          ...baseStepRun,
          id: "srun-review-1",
          status: "succeeded" as const,
          executionDurationMs: priorReviewMs,
        },
      ],
    } as WorkItemRecord

    // Needs Human handoff: label shows NEEDS_HUMAN with prior duration retained.
    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "REVIEW",
        label: "Review: Needs human",
        status: "NEEDS_HUMAN",
        durationMs: priorReviewMs,
      },
    ])

    const retriedQueued = {
      ...workItem,
      state: "review",
      stepRuns: [
        ...workItem.stepRuns,
        {
          ...baseStepRun,
          id: "srun-review-2",
          status: "queued" as const,
          startedAt: null,
          finishedAt: null,
          executionDurationMs: null,
          queueWaitMs: 0,
        },
      ],
    } as WorkItemRecord

    expect(lifecycleLabels(retriedQueued)).toEqual([
      {
        phase: "REVIEW",
        label: "Review: Queued",
        status: "QUEUED",
        durationMs: priorReviewMs,
      },
    ])
  })

  test("applies the same cumulative timing to other retryable steps", () => {
    const firstAttemptMs = 120_000
    const secondAttemptMs = 30_000
    const workItem = {
      ...baseWorkItem,
      state: "implement",
      stepRuns: [
        {
          ...baseStepRun,
          id: "srun-impl-1",
          step: "implement" as const,
          status: "failed" as const,
          executionDurationMs: firstAttemptMs,
          finishedAt: new Date("2026-07-14T08:02:00.000Z"),
        },
        {
          ...baseStepRun,
          id: "srun-impl-2",
          step: "implement" as const,
          status: "interrupted" as const,
          executionDurationMs: 60_000,
          finishedAt: new Date("2026-07-14T08:04:00.000Z"),
        },
        {
          ...baseStepRun,
          id: "srun-impl-3",
          step: "implement" as const,
          status: "running" as const,
          startedAt: new Date("2026-07-14T08:05:00.000Z"),
          finishedAt: null,
          executionDurationMs: secondAttemptMs,
        },
      ],
    } as WorkItemRecord

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "IMPLEMENT",
        label: "Build: Running",
        status: "RUNNING",
        durationMs: firstAttemptMs + 60_000 + secondAttemptMs,
      },
    ])
  })

  test("starts a first attempt at 0s with no prior runs", () => {
    const workItem = {
      ...baseWorkItem,
      state: "implement",
      stepRuns: [
        {
          ...baseStepRun,
          id: "srun-impl-1",
          step: "implement" as const,
          status: "running" as const,
          startedAt: new Date("2026-07-14T08:00:01.000Z"),
          finishedAt: null,
          executionDurationMs: 0,
        },
      ],
    } as WorkItemRecord

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "IMPLEMENT",
        label: "Build: Running",
        status: "RUNNING",
        durationMs: 0,
      },
    ])
  })

  test("does not blend durations across different lifecycle phases", () => {
    const workItem = {
      ...baseWorkItem,
      state: "review",
      stepRuns: [
        {
          ...baseStepRun,
          id: "srun-impl-1",
          step: "implement" as const,
          status: "succeeded" as const,
          executionDurationMs: 500_000,
        },
        {
          ...baseStepRun,
          id: "srun-review-1",
          step: "review" as const,
          status: "running" as const,
          finishedAt: null,
          executionDurationMs: 10_000,
        },
      ],
    } as WorkItemRecord

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "IMPLEMENT",
        label: "Build: Succeeded",
        status: "SUCCEEDED",
        durationMs: 500_000,
      },
      {
        phase: "REVIEW",
        label: "Review: reviewing",
        status: "RUNNING",
        durationMs: 10_000,
      },
    ])
  })
})
