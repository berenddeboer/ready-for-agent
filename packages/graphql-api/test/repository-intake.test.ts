import { EnqueueError } from "@ready-for-agent/queue-service"
import {
  IssueBlockedError,
  IssueNotBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  ParentIssueError,
  UnfinishedWorkItemExistsError,
} from "@ready-for-agent/work-item-lifecycle"
import {
  isCandidateLocalIntakeError,
  toCandidateLocalIntakeError,
} from "../src/lib/repository-intake.js"
import { describe, expect, test } from "bun:test"

describe("Repository Intake candidate-local errors", () => {
  test("classifies Implement Now / Queue races as candidate-local", () => {
    const cases = [
      new IssueNotFoundError({ repositoryId: "r", issueNumber: 1 }),
      new IssueNotOpenError({
        repositoryId: "r",
        issueNumber: 2,
        state: "CLOSED",
      }),
      new ParentIssueError({ repositoryId: "r", issueNumber: 3 }),
      new IssueBlockedError({
        repositoryId: "r",
        issueNumber: 4,
        blockerCount: 2,
      }),
      new IssueNotBlockedError({ repositoryId: "r", issueNumber: 5 }),
      new UnfinishedWorkItemExistsError({
        repositoryId: "r",
        issueNumber: 6,
        workItemId: "wi-6",
      }),
    ]
    for (const error of cases) {
      expect(isCandidateLocalIntakeError(error)).toBe(true)
      const mapped = toCandidateLocalIntakeError(error)
      expect(mapped.code.length).toBeGreaterThan(0)
      expect(mapped.message.length).toBeGreaterThan(0)
    }
  })

  test("maps unfinished Work Item race to stable code and message", () => {
    const error = new UnfinishedWorkItemExistsError({
      repositoryId: "repo-1",
      issueNumber: 9,
      workItemId: "wi-existing",
    })
    expect(toCandidateLocalIntakeError(error)).toEqual({
      code: "UNFINISHED_WORK_ITEM_EXISTS",
      message: "Issue #9 already has an unfinished Work Item",
    })
  })

  test("treats infrastructure failures as operation-level", () => {
    const error = new EnqueueError({
      queue: "work-item-steps",
      message: "queue infrastructure failed",
    })
    expect(isCandidateLocalIntakeError(error)).toBe(false)
  })
})
