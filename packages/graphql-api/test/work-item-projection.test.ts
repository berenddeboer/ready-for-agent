import type { WorkItemRecord } from "@ready-for-agent/work-item-lifecycle"
import {
  COMMIT_COPY_GENERATION_MESSAGE,
  COMMIT_HOOKS_MESSAGE,
  COMMIT_REPAIR_MESSAGE,
  STEP_RUN_REASON,
  WAITING_FOR_AGENT_TURN_MESSAGE,
} from "@ready-for-agent/work-item-lifecycle"
import {
  cumulativeExecutionDurationMs,
  lifecycleLabels,
  statusLabel,
  workItemCanAutonomousRetry,
  workItemCanRetry,
  workItemHasActiveStepRun,
  workItemLatestStepRunDetail,
  workItemLatestStepRunReason,
  workItemPostponedUntil,
  workItemStateLabel,
  workItemStatus,
  workItemStatusLabel,
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
  reasonDetail: null,
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
  autoMergeOverride: null,
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
    expect(
      workItemCanRetry(
        workItemWith({
          state: "implement",
          paused: false,
          waitingSince: null,
          waitingForBlockers: false,
          stepRuns: [{ ...baseStepRun, status: "failed" }],
        }),
      ),
    ).toBe(true)
    expect(
      workItemCanRetry(
        workItemWith({
          state: "needs_human",
          stepRuns: [{ ...baseStepRun, step: "review", status: "succeeded" }],
        }),
      ),
    ).toBe(true)
    expect(
      workItemCanRetry(
        workItemWith({
          state: "failed",
          failureCode: "handler_failed",
        }),
      ),
    ).toBe(false)
    expect(workItemCanRetry(workItemWith({ paused: true }))).toBe(false)
    expect(
      workItemCanRetry(
        workItemWith({
          paused: false,
          stepRuns: [
            {
              ...baseStepRun,
              status: "interrupted",
              reasonCode: STEP_RUN_REASON.paused,
            },
          ],
        }),
      ),
    ).toBe(true)
    expect(
      workItemCanAutonomousRetry(
        workItemWith({
          paused: false,
          stepRuns: [
            {
              ...baseStepRun,
              status: "interrupted",
              reasonCode: STEP_RUN_REASON.paused,
            },
          ],
        }),
      ),
    ).toBe(false)
    expect(
      workItemHasActiveStepRun(
        workItemWith({
          stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
        }),
      ),
    ).toBe(true)
    expect(
      workItemHasActiveStepRun(
        workItemWith({
          stepRuns: [{ ...baseStepRun, status: "failed" }],
        }),
      ),
    ).toBe(false)
    expect(
      workItemStatus(
        workItemWith({
          paused: true,
          stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
        }),
      ),
    ).toBe("needs_human_review")
    expect(
      workItemStatusLabel(
        workItemWith({
          paused: true,
          stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
        }),
      ),
    ).toBe("Draining")
    expect(
      workItemCanRetry(
        workItemWith({ waitingSince: new Date("2026-07-14T08:05:00.000Z") }),
      ),
    ).toBe(false)
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

describe("paused Work Item statusLabel drain", () => {
  test("labels a paused Work Item with a running Step Run as Draining", () => {
    const draining = workItemWith({
      paused: true,
      stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
    })
    expect(workItemStatus(draining)).toBe("needs_human_review")
    expect(workItemStatusLabel(draining)).toBe("Draining")
    expect(lifecycleLabels(draining)).toEqual([
      {
        phase: "REVIEW",
        label: "Review: reviewing",
        status: "RUNNING",
        durationMs: 2_315_000,
      },
    ])
  })

  test("labels a paused Work Item with a queued Step Run as Draining", () => {
    const draining = workItemWith({
      paused: true,
      stepRuns: [
        {
          ...baseStepRun,
          status: "queued",
          startedAt: null,
          finishedAt: null,
          executionDurationMs: null,
        },
      ],
    })
    expect(workItemStatus(draining)).toBe("needs_human_review")
    expect(workItemStatusLabel(draining)).toBe("Draining")
  })

  test("keeps idle paused Work Items as Needs human review", () => {
    const idlePaused = workItemWith({
      paused: true,
      stepRuns: [{ ...baseStepRun, status: "succeeded" }],
    })
    expect(workItemStatus(idlePaused)).toBe("needs_human_review")
    expect(workItemStatusLabel(idlePaused)).toBe("Needs human review")
  })

  test("restores the live Step Run label after Start during drain", () => {
    const startedDuringDrain = workItemWith({
      paused: false,
      stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
    })
    expect(workItemStatus(startedDuringDrain)).toBe("running")
    expect(workItemStatusLabel(startedDuringDrain)).toBe("Running")
  })

  test("does not relabel waiting-for-blockers or waiting-for-worker-slot over Pause", () => {
    const pausedWaitingForBlockers = workItemWith({
      paused: true,
      waitingForBlockers: true,
      stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
    })
    expect(workItemStatus(pausedWaitingForBlockers)).toBe(
      "waiting_for_blockers",
    )
    expect(workItemStatusLabel(pausedWaitingForBlockers)).toBe(
      "Waiting for blockers",
    )

    const pausedWaitingForSlot = workItemWith({
      paused: true,
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
    })
    expect(workItemStatus(pausedWaitingForSlot)).toBe("waiting_for_worker_slot")
    expect(workItemStatusLabel(pausedWaitingForSlot)).toBe(
      "Waiting for worker slot",
    )
  })

  test("keeps terminal Needs human distinct from drain", () => {
    const needsHuman = workItemWith({
      state: "needs_human",
      paused: false,
      stepRuns: [{ ...baseStepRun, status: "succeeded" }],
    })
    expect(workItemStatus(needsHuman)).toBe("needs_human")
    expect(workItemStatusLabel(needsHuman)).toBe("Needs human")
  })
})

describe("status-checks phase labels", () => {
  const watchRun = {
    ...baseStepRun,
    id: "srun-watch",
    step: "watch_pr_status_checks" as const,
    status: "running" as const,
    finishedAt: null,
    executionDurationMs: 12_000,
  } satisfies WorkItemRecord["stepRuns"][number]

  const investigateRun = {
    ...baseStepRun,
    id: "srun-investigate",
    step: "investigate_pr_status_checks" as const,
    status: "running" as const,
    finishedAt: null,
    executionDurationMs: 45_000,
  } satisfies WorkItemRecord["stepRuns"][number]

  test.each([
    ["running", "Running", "RUNNING"],
    ["succeeded", "Succeeded", "SUCCEEDED"],
    ["failed", "Failed", "FAILED"],
    ["queued", "Queued", "QUEUED"],
  ] as const)(
    "labels the chip Addressing status check findings when the latest phase run is investigate (%s)",
    (status, outcome, statusCode) => {
      const workItem = workItemWith({
        state: "investigate_pr_status_checks",
        stepRuns: [
          {
            ...investigateRun,
            status,
            finishedAt:
              status === "running" || status === "queued"
                ? null
                : new Date("2026-07-14T08:38:36.000Z"),
          },
        ],
      })

      expect(lifecycleLabels(workItem)).toEqual([
        {
          phase: "GITHUB_STATUS_CHECKS",
          label: `Addressing status check findings: ${outcome}`,
          status: statusCode,
          durationMs: 45_000,
        },
      ])
    },
  )

  test("keeps the Status checks chip when the latest phase run is watch", () => {
    const workItem = workItemWith({
      state: "watch_pr_status_checks",
      stepRuns: [watchRun],
    })

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Running",
        status: "RUNNING",
        durationMs: 12_000,
      },
    ])
    expect(workItemStateLabel(workItem)).toBe("Status checks")
  })

  test("uses the latest run in the collapsed phase after watch then investigate", () => {
    const workItem = workItemWith({
      state: "investigate_pr_status_checks",
      stepRuns: [
        {
          ...watchRun,
          status: "succeeded",
          finishedAt: new Date("2026-07-14T08:10:00.000Z"),
          executionDurationMs: 12_000,
        },
        investigateRun,
      ],
    })

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Addressing status check findings: Running",
        status: "RUNNING",
        durationMs: 12_000 + 45_000,
      },
    ])
  })

  test("returns to Status checks when a later watch run follows investigate", () => {
    const workItem = workItemWith({
      state: "watch_pr_status_checks",
      stepRuns: [
        {
          ...investigateRun,
          status: "succeeded",
          finishedAt: new Date("2026-07-14T08:20:00.000Z"),
          executionDurationMs: 45_000,
        },
        {
          ...watchRun,
          id: "srun-watch-2",
          status: "queued",
          finishedAt: null,
          executionDurationMs: null,
        },
      ],
    })

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Queued",
        status: "QUEUED",
        durationMs: 45_000,
      },
    ])
    expect(workItemStateLabel(workItem)).toBe("Status checks")
  })

  test("standalone investigate state label reads Addressing status check findings", () => {
    expect(
      workItemStateLabel(
        workItemWith({
          state: "investigate_pr_status_checks",
          stepRuns: [investigateRun],
        }),
      ),
    ).toBe("Addressing status check findings")
  })

  test("keeps postponed history on Status checks when latest run is investigate", () => {
    const postponedUntil = new Date("2026-08-07T12:00:00.000Z")
    const workItem = workItemWith({
      state: "investigate_pr_status_checks",
      holdsWorkerSlot: true,
      stepRuns: [
        {
          ...watchRun,
          status: "postponed",
          finishedAt: new Date("2026-08-07T11:00:00.000Z"),
          postponedUntil,
          executionDurationMs: 2_315_000,
        },
        investigateRun,
      ],
    })

    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Status checks: Postponed (1 prior attempt)",
        status: "POSTPONED",
        durationMs: null,
      },
      {
        phase: "GITHUB_STATUS_CHECKS",
        label: "Addressing status check findings: Running",
        status: "RUNNING",
        durationMs: 2_315_000 + 45_000,
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

describe("Commit running subphases", () => {
  const runningCommit = (
    reasonCode: string,
    reasonMessage: string,
  ): WorkItemRecord =>
    workItemWith({
      state: "commit",
      stepRuns: [
        {
          ...baseStepRun,
          step: "commit",
          status: "running",
          finishedAt: null,
          reasonCode,
          reasonMessage,
        },
      ],
    })

  test("surfaces generating publication copy as the live status message", () => {
    const workItem = runningCommit(
      STEP_RUN_REASON.copyGeneration,
      COMMIT_COPY_GENERATION_MESSAGE,
    )
    expect(workItemStatus(workItem)).toBe("running")
    expect(workItemStatusMessage(workItem)).toBe(COMMIT_COPY_GENERATION_MESSAGE)
    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "COMMIT",
        label: "Commit: Running",
        status: "RUNNING",
        durationMs: 2_315_000,
      },
    ])
  })

  test("surfaces running commit hooks as the live status message", () => {
    const workItem = runningCommit(
      STEP_RUN_REASON.commitHooks,
      COMMIT_HOOKS_MESSAGE,
    )
    expect(workItemStatusMessage(workItem)).toBe(COMMIT_HOOKS_MESSAGE)
  })

  test("surfaces repairing failed commit as the live status message", () => {
    const workItem = runningCommit(
      STEP_RUN_REASON.commitRepair,
      COMMIT_REPAIR_MESSAGE,
    )
    expect(workItemStatusMessage(workItem)).toBe(COMMIT_REPAIR_MESSAGE)
  })

  test("lets waiting for an Agent Turn slot take precedence over a Commit subphase", () => {
    const workItem = runningCommit(
      STEP_RUN_REASON.waitingForAgentTurn,
      WAITING_FOR_AGENT_TURN_MESSAGE,
    )
    expect(workItemStatus(workItem)).toBe("queued")
    expect(workItemStatusMessage(workItem)).toBe(WAITING_FOR_AGENT_TURN_MESSAGE)
    expect(lifecycleLabels(workItem)).toEqual([
      {
        phase: "COMMIT",
        label: "Commit: Queued",
        status: "QUEUED",
        durationMs: 2_315_000,
      },
    ])
  })
})

describe("workItemLatestStepRunDetail", () => {
  test("returns null when the latest Step Run has no persisted detail", () => {
    expect(workItemLatestStepRunDetail(baseWorkItem)).toBeNull()
  })

  test("parses the latest Step Run cause chain for operator display", () => {
    const failed = workItemWith({
      state: "implement",
      stepRuns: [
        {
          ...baseStepRun,
          step: "implement",
          status: "failed",
          reasonCode: "handler_failed",
          reasonMessage: 'Executable not found in $PATH: "claude"',
          reasonDetail: JSON.stringify({
            causeChain: [
              {
                name: "Error",
                code: "ENOENT",
                message: 'ENOENT: Executable not found in $PATH: "claude"',
              },
            ],
            code: "ENOENT",
          }),
        },
      ],
    })

    expect(workItemLatestStepRunDetail(failed)).toEqual({
      causeChain: [
        {
          name: "Error",
          code: "ENOENT",
          message: 'ENOENT: Executable not found in $PATH: "claude"',
        },
      ],
      code: "ENOENT",
    })
  })
})

describe("operator Retry eligibility and latest Step Run reason", () => {
  const implementFailedWithDetail = workItemWith({
    state: "implement",
    stepRuns: [
      {
        ...baseStepRun,
        step: "implement",
        status: "failed",
        reasonCode: "handler_failed",
        reasonMessage: "Claude Code failed to implement the Work Item issue",
        reasonDetail: JSON.stringify({
          causeChain: [
            {
              name: "ImplementOpenCodeError",
              message: "Claude Code failed to implement the Work Item issue",
            },
            {
              name: "Error",
              code: "ENOENT",
              message: 'ENOENT: Executable not found in $PATH: "claude"',
            },
          ],
          code: "ENOENT",
        }),
      },
    ],
  })

  const terminalIssueNotOpen = workItemWith({
    state: "failed",
    failureCode: "issue_not_open",
    failureMessage: "Issue is not open",
    stepRuns: [
      {
        ...baseStepRun,
        step: "close_issue",
        status: "failed",
        reasonCode: "issue_not_open",
        reasonMessage: "Issue is not open",
        reasonDetail: null,
      },
    ],
  })

  const retryableNeedsHuman = workItemWith({
    state: "needs_human",
    failureCode: "needs_human",
    failureMessage: "Human must review findings",
    stepRuns: [
      {
        ...baseStepRun,
        step: "review",
        status: "succeeded",
        reasonCode: "review_accepted",
        reasonMessage: "Human must review findings",
        reasonDetail: null,
      },
    ],
  })

  const interruptedWithoutDetail = workItemWith({
    state: "implement",
    stepRuns: [
      {
        ...baseStepRun,
        step: "implement",
        status: "interrupted",
        reasonCode: "interrupted",
        reasonMessage:
          "Lifecycle Step was interrupted before an outcome could be established",
        reasonDetail: null,
      },
    ],
  })

  test("Forge HTTP 401/403 Step Run is not retryable, including Autonomous Retry", () => {
    const mergePrAuthRejected = workItemWith({
      state: "merge_pr",
      stepRuns: [
        {
          ...baseStepRun,
          step: "merge_pr",
          status: "failed",
          reasonCode: STEP_RUN_REASON.forgeAuthRejected,
          reasonMessage:
            "Failed to merge pull request 42 for acme/widgets: HTTP 401 Unauthorized",
          reasonDetail: null,
        },
      ],
    })
    expect(workItemCanRetry(mergePrAuthRejected)).toBe(false)
    expect(workItemCanAutonomousRetry(mergePrAuthRejected)).toBe(false)
    expect(workItemLatestStepRunReason(mergePrAuthRejected)).toEqual({
      code: "forge_auth_rejected",
      message:
        "Failed to merge pull request 42 for acme/widgets: HTTP 401 Unauthorized",
      retryAt: null,
      detail: null,
    })
  })

  test("retryable failed Step Run keeps canRetry and structured reason with detail", () => {
    expect(workItemCanRetry(implementFailedWithDetail)).toBe(true)
    expect(workItemStatus(implementFailedWithDetail)).toBe("failed")
    expect(workItemLatestStepRunReason(implementFailedWithDetail)).toEqual({
      code: "handler_failed",
      message: "Claude Code failed to implement the Work Item issue",
      retryAt: null,
      detail: {
        causeChain: [
          {
            name: "ImplementOpenCodeError",
            message: "Claude Code failed to implement the Work Item issue",
          },
          {
            name: "Error",
            code: "ENOENT",
            message: 'ENOENT: Executable not found in $PATH: "claude"',
          },
        ],
        code: "ENOENT",
      },
    })
  })

  test("non-retryable terminal failure stays distinguishable from a retryable Step Run", () => {
    expect(workItemCanRetry(terminalIssueNotOpen)).toBe(false)
    expect(workItemStatus(terminalIssueNotOpen)).toBe("failed")
    expect(workItemLatestStepRunReason(terminalIssueNotOpen)).toEqual({
      code: "issue_not_open",
      message: "Issue is not open",
      detail: null,
      retryAt: null,
    })
  })

  test("retryable Needs Human handoff exposes canRetry and the latest Step Run reason", () => {
    expect(workItemCanRetry(retryableNeedsHuman)).toBe(true)
    expect(workItemStatus(retryableNeedsHuman)).toBe("needs_human")
    expect(workItemLatestStepRunReason(retryableNeedsHuman)).toEqual({
      code: "review_accepted",
      message: "Human must review findings",
      detail: null,
      retryAt: null,
    })
  })

  test("missing-check Needs Human handoff is retryable", () => {
    const missingChecks = workItemWith({
      state: "needs_human",
      failureCode: "needs_human",
      failureMessage:
        "No status checks were reported for this pull request by the check-start deadline.",
      stepRuns: [
        {
          ...baseStepRun,
          step: "watch_pr_status_checks",
          status: "succeeded",
          reasonCode: "missing_successful_checks",
          reasonMessage:
            "No status checks were reported for this pull request by the check-start deadline.",
        },
      ],
    })
    expect(workItemCanRetry(missingChecks)).toBe(true)
    expect(workItemLatestStepRunReason(missingChecks)).toEqual({
      code: "missing_successful_checks",
      message:
        "No status checks were reported for this pull request by the check-start deadline.",
      detail: null,
      retryAt: null,
    })
  })

  test("unavailable persisted detail stays null without inventing a cause chain", () => {
    expect(workItemCanRetry(interruptedWithoutDetail)).toBe(true)
    expect(workItemLatestStepRunReason(interruptedWithoutDetail)).toEqual({
      code: "interrupted",
      message:
        "Lifecycle Step was interrupted before an outcome could be established",
      detail: null,
      retryAt: null,
    })
  })

  test("returns null latest Step Run reason when no Step Run exists", () => {
    expect(
      workItemLatestStepRunReason(workItemWith({ stepRuns: [] })),
    ).toBeNull()
  })

  test("exposes a persisted provider hold on latestStepRunReason without clearing canRetry", () => {
    const retryAt = "2026-08-15T13:00:00.000Z"
    const held = workItemWith({
      state: "implement",
      stepRuns: [
        {
          ...baseStepRun,
          status: "failed",
          reasonCode: "handler_failed",
          reasonMessage: "rate limited",
          reasonDetail: JSON.stringify({
            causeChain: [{ message: "Too Many Requests" }],
            retryAt,
          }),
        },
        {
          ...baseStepRun,
          id: "srun-01J00000000000000000000001",
          status: "failed",
          reasonCode: "handler_failed",
          reasonMessage: "rate limited again",
          reasonDetail: JSON.stringify({
            causeChain: [{ message: "Too Many Requests" }],
            retryAt,
          }),
        },
      ],
    })
    expect(workItemCanRetry(held)).toBe(true)
    expect(workItemLatestStepRunReason(held)).toEqual({
      code: "handler_failed",
      message: "rate limited again",
      retryAt,
      detail: {
        causeChain: [{ message: "Too Many Requests" }],
        retryAt,
      },
    })
  })
})
