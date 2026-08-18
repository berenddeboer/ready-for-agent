import { EnqueueError } from "@ready-for-agent/queue-service"
import {
  ActiveStepRunExistsError,
  AutonomousRetryDeferredError,
  AutonomousRetryLimitReachedError,
  RetryNotEligibleError,
  type WorkItemRecord,
  WorkItemTerminalError,
} from "@ready-for-agent/work-item-lifecycle"
import {
  InvalidRetrySelectorError,
  NoUnfinishedWorkItemError,
  WorkItemNotInRepositoryError,
  isItemLocalRetryError,
  parseMaxAutonomousRetries,
  parseRetryWorkItemsSelector,
  snapshotRetryTargets,
  toRetryItemError,
} from "../src/lib/repository-retry.js"
import { describe, expect, test } from "bun:test"

const baseStepRun = {
  id: "srun-01J00000000000000000000000",
  workItemId: "wi-01J00000000000000000000000",
  step: "implement" as const,
  status: "failed" as const,
  queueJobId: null,
  queuedAt: new Date("2026-07-14T08:00:00.000Z"),
  startedAt: new Date("2026-07-14T08:00:01.000Z"),
  finishedAt: new Date("2026-07-14T08:01:00.000Z"),
  reasonCode: null,
  reasonMessage: null,
  reasonDetail: null,
  postponedUntil: null,
  queueWaitMs: 1_000,
  executionDurationMs: 59_000,
}

const baseWorkItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: "repo-1",
  issueNumber: 42,
  issueTitle: "Example",
  agentBackend: "opencode",
  state: "implement",
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  paused: false,
  waitingSince: null,
  waitingForBlockers: false,
  mergeMode: "ordinary",
  autoMergeOverride: null,
  holdsWorkerSlot: false,
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
  updatedAt: new Date("2026-07-14T08:01:00.000Z"),
  stateResidenceMs: 60_000,
  stepRuns: [baseStepRun],
} as WorkItemRecord

const workItemWith = (overrides: Partial<WorkItemRecord>): WorkItemRecord => ({
  ...baseWorkItem,
  ...overrides,
})

describe("parseMaxAutonomousRetries", () => {
  test("defaults to 3 and accepts a non-negative override", () => {
    expect(parseMaxAutonomousRetries(undefined)).toBe(3)
    expect(parseMaxAutonomousRetries(null)).toBe(3)
    expect(parseMaxAutonomousRetries(0)).toBe(0)
    expect(parseMaxAutonomousRetries(5)).toBe(5)
  })

  test("rejects a negative or non-integer override", () => {
    expect(parseMaxAutonomousRetries(-1)).toBeInstanceOf(
      InvalidRetrySelectorError,
    )
    expect(parseMaxAutonomousRetries(1.5)).toBeInstanceOf(
      InvalidRetrySelectorError,
    )
  })
})

describe("parseRetryWorkItemsSelector", () => {
  test("requires exactly one selector", () => {
    expect(parseRetryWorkItemsSelector({})).toBeInstanceOf(
      InvalidRetrySelectorError,
    )
    expect(
      parseRetryWorkItemsSelector({
        issueNumber: 7,
        workItemId: "wi-1",
      }),
    ).toBeInstanceOf(InvalidRetrySelectorError)
    expect(
      parseRetryWorkItemsSelector({
        issueNumber: 7,
        allRetryable: true,
      }),
    ).toBeInstanceOf(InvalidRetrySelectorError)
    expect(
      parseRetryWorkItemsSelector({
        workItemId: "wi-1",
        allRetryable: true,
      }),
    ).toBeInstanceOf(InvalidRetrySelectorError)
  })

  test("treats allRetryable false and blank workItemId as unset", () => {
    expect(
      parseRetryWorkItemsSelector({
        allRetryable: false,
        workItemId: "  ",
      }),
    ).toBeInstanceOf(InvalidRetrySelectorError)
    expect(parseRetryWorkItemsSelector({ allRetryable: true })).toEqual({
      kind: "all-retryable",
    })
  })

  test("rejects a non-positive issue number", () => {
    const parsed = parseRetryWorkItemsSelector({ issueNumber: 0 })
    expect(parsed).toBeInstanceOf(InvalidRetrySelectorError)
    if (parsed instanceof InvalidRetrySelectorError) {
      expect(parsed.reason).toBe("invalid_issue_number")
    }
  })

  test("accepts each exclusive selector", () => {
    expect(parseRetryWorkItemsSelector({ issueNumber: 12 })).toEqual({
      kind: "issue",
      issueNumber: 12,
    })
    expect(parseRetryWorkItemsSelector({ workItemId: " wi-9 " })).toEqual({
      kind: "work-item",
      workItemId: "wi-9",
    })
  })
})

describe("snapshotRetryTargets", () => {
  const failedInterrupted = workItemWith({
    id: "wi-failed",
    issueNumber: 20,
    state: "implement",
    stepRuns: [{ ...baseStepRun, status: "failed" }],
  })
  const interrupted = workItemWith({
    id: "wi-interrupted",
    issueNumber: 21,
    state: "commit",
    stepRuns: [{ ...baseStepRun, step: "commit", status: "interrupted" }],
  })
  const interruptedPaused = workItemWith({
    id: "wi-interrupted-paused",
    issueNumber: 32,
    state: "create_worktree",
    paused: false,
    stepRuns: [
      {
        ...baseStepRun,
        step: "create_worktree",
        status: "interrupted",
        reasonCode: "paused",
      },
    ],
  })
  const retryableNeedsHuman = workItemWith({
    id: "wi-nh-review",
    issueNumber: 22,
    state: "needs_human",
    stepRuns: [{ ...baseStepRun, step: "review", status: "succeeded" }],
  })
  const retryableFailed = workItemWith({
    id: "wi-legacy-failed",
    issueNumber: 23,
    state: "failed",
    failureCode: "pr_status_checks_unresolved",
    stepRuns: [
      {
        ...baseStepRun,
        step: "watch_pr_status_checks",
        status: "succeeded",
      },
    ],
  })
  const decideNeedsHuman = workItemWith({
    id: "wi-nh-decide",
    issueNumber: 24,
    state: "needs_human",
    stepRuns: [
      { ...baseStepRun, step: "decide_pr_merge", status: "succeeded" },
    ],
  })
  const paused = workItemWith({
    id: "wi-paused",
    issueNumber: 25,
    paused: true,
  })
  const postponed = workItemWith({
    id: "wi-postponed",
    issueNumber: 26,
    state: "watch_pr_status_checks",
    stepRuns: [
      {
        ...baseStepRun,
        step: "watch_pr_status_checks",
        status: "postponed",
        postponedUntil: new Date("2026-08-07T12:00:00.000Z"),
      },
    ],
  })
  const running = workItemWith({
    id: "wi-running",
    issueNumber: 27,
    holdsWorkerSlot: true,
    stepRuns: [{ ...baseStepRun, status: "running", finishedAt: null }],
  })
  const waitingSlot = workItemWith({
    id: "wi-waiting-slot",
    issueNumber: 28,
    waitingSince: new Date("2026-07-14T08:05:00.000Z"),
  })
  const waitingBlockers = workItemWith({
    id: "wi-waiting-blockers",
    issueNumber: 29,
    waitingForBlockers: true,
    stepRuns: [],
  })
  const terminalFailed = workItemWith({
    id: "wi-terminal-failed",
    issueNumber: 30,
    state: "failed",
    failureCode: "handler_failed",
  })
  const complete = workItemWith({
    id: "wi-complete",
    issueNumber: 31,
    state: "complete",
    stepRuns: [{ ...baseStepRun, status: "succeeded" }],
  })

  const all = [
    complete,
    terminalFailed,
    waitingBlockers,
    waitingSlot,
    running,
    postponed,
    paused,
    decideNeedsHuman,
    retryableFailed,
    retryableNeedsHuman,
    interrupted,
    interruptedPaused,
    failedInterrupted,
  ]

  test("all-retryable uses canRetry and excludes paused, postponed, active, waiting, and terminal", () => {
    const snapshot = snapshotRetryTargets({
      selector: { kind: "all-retryable" },
      repositoryId: "repo-1",
      workItems: all,
    })
    expect(Array.isArray(snapshot)).toBe(true)
    if (!Array.isArray(snapshot)) {
      throw new Error("expected snapshot list")
    }
    expect(snapshot.map((item) => item.id)).toEqual([
      "wi-failed",
      "wi-interrupted",
      "wi-nh-review",
      "wi-legacy-failed",
    ])
  })

  test("issue selector targets the current unfinished Work Item", () => {
    const older = workItemWith({
      id: "wi-old",
      issueNumber: 9,
      state: "complete",
      createdAt: new Date("2026-07-13T08:00:00.000Z"),
    })
    const current = workItemWith({
      id: "wi-current",
      issueNumber: 9,
      createdAt: new Date("2026-07-14T08:00:00.000Z"),
    })
    const snapshot = snapshotRetryTargets({
      selector: { kind: "issue", issueNumber: 9 },
      repositoryId: "repo-1",
      workItems: [older, current],
    })
    expect(snapshot).toEqual([current])
  })

  test("issue selector fails when there is no unfinished Work Item", () => {
    const snapshot = snapshotRetryTargets({
      selector: { kind: "issue", issueNumber: 31 },
      repositoryId: "repo-1",
      workItems: [complete],
    })
    expect(snapshot).toBeInstanceOf(NoUnfinishedWorkItemError)
  })

  test("work-item selector verifies repository membership", () => {
    const foreign = workItemWith({
      id: "wi-foreign",
      repositoryId: "repo-other",
    })
    expect(
      snapshotRetryTargets({
        selector: { kind: "work-item", workItemId: "wi-foreign" },
        repositoryId: "repo-1",
        workItems: [foreign],
      }),
    ).toBeInstanceOf(WorkItemNotInRepositoryError)
    expect(
      snapshotRetryTargets({
        selector: { kind: "work-item", workItemId: "wi-failed" },
        repositoryId: "repo-1",
        workItems: [failedInterrupted],
      }),
    ).toEqual([failedInterrupted])
  })
})

describe("item-local Retry errors", () => {
  test("classifies ineligible and concurrent races as item-local", () => {
    const cases = [
      new RetryNotEligibleError({ workItemId: "wi-1", reason: "paused" }),
      new WorkItemTerminalError({ workItemId: "wi-1", state: "complete" }),
      new ActiveStepRunExistsError({
        workItemId: "wi-1",
        stepRunId: "sr-1",
        status: "running",
      }),
      { _tag: "WorkItemNotFoundError" as const, workItemId: "wi-1" },
      new AutonomousRetryLimitReachedError({
        workItemId: "wi-1",
        used: 3,
        max: 3,
      }),
      new AutonomousRetryDeferredError({
        workItemId: "wi-1",
        retryAt: Date.parse("2026-08-15T13:00:00.000Z"),
      }),
    ]
    for (const error of cases) {
      expect(isItemLocalRetryError(error)).toBe(true)
      const mapped = toRetryItemError(error)
      expect(mapped.code.length).toBeGreaterThan(0)
      expect(mapped.message.length).toBeGreaterThan(0)
    }
  })

  test("maps concurrent Retry to ACTIVE_STEP_RUN_EXISTS", () => {
    expect(
      toRetryItemError(
        new ActiveStepRunExistsError({
          workItemId: "wi-1",
          stepRunId: "sr-1",
          status: "running",
        }),
      ),
    ).toEqual({
      code: "ACTIVE_STEP_RUN_EXISTS",
      message: "Work Item wi-1 already has an active Step Run",
    })
  })

  test("treats infrastructure failures as operation-level", () => {
    const error = new EnqueueError({
      queue: "work-item-steps",
      message: "queue infrastructure failed",
    })
    expect(isItemLocalRetryError(error)).toBe(false)
  })
})
