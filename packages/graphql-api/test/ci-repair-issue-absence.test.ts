import type { WorkItemRecord } from "@ready-for-agent/work-item-lifecycle"
import { includeWorkItemOnIssueBoard } from "../src/lib/kanban-projection.js"
import { issueSyncWorkItems } from "../src/lib/repository-intake.js"
import { describe, expect, test } from "bun:test"

const shared = {
  id: "wi-01J00000000000000000000000",
  repositoryId: "repo-1",
  ciRepairDefaultBranch: "main",
  ciRepairHeadSha: null,
  ciRepairFailingRuns: [],
  issueTitle: "Repair CI on main",
  pullRequestNumber: null,
  agentBackend: "opencode",
  executionProfile: null,
  state: "failed" as const,
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  paused: false,
  waitingSince: null,
  waitingForBlockers: false,
  waitingForCiRepair: false,
  mergeMode: "ordinary" as const,
  autoMergeOverride: null,
  holdsWorkerSlot: false,
  pauseBeforeStep: null,
  worktreePath: null,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: null,
  failureCode: "handler_failed",
  failureMessage: null,
  createdAt: new Date("2026-07-14T08:00:00.000Z"),
  updatedAt: new Date("2026-07-14T08:00:00.000Z"),
  stateResidenceMs: 0,
  stepRuns: [],
}

const ciRepair: WorkItemRecord = {
  ...shared,
  origin: "ci_repair",
}

const issueWorkItem: WorkItemRecord = {
  ...shared,
  id: "wi-01J00000000000000000000001",
  origin: "issue",
  issueNumber: 42,
  issueSource: {
    tracker: "github",
    nativeId: "42",
    displayId: "42",
    url: "https://github.com/acme/widgets/issues/42",
  },
  issueTitle: "Example",
  ciRepairDefaultBranch: null,
}

describe("CI Repair Work Items are not placeholder Issues", () => {
  test("issue sync ignores a CI Repair Work Item", () => {
    expect(issueSyncWorkItems([ciRepair, issueWorkItem])).toEqual([
      {
        issueNumber: 42,
        issueTracker: "github",
        nativeId: "42",
        id: issueWorkItem.id,
        state: "failed",
        canRetry: false,
      },
    ])
  })

  test("kanban presents a failed CI Repair Work Item instead of matching an Issue", () => {
    const relevant = new Set(["42"])
    expect(includeWorkItemOnIssueBoard(ciRepair, relevant)).toBe(true)
    expect(includeWorkItemOnIssueBoard(issueWorkItem, new Set())).toBe(false)
    expect(includeWorkItemOnIssueBoard(issueWorkItem, relevant)).toBe(true)
  })
})
