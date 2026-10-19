import { SqlError, UniqueViolation } from "effect/sql/SqlError"
import {
  isUnfinishedCiRepairUniqueViolation,
  isUnfinishedIssueWorkItemUniqueViolation,
} from "../src/lib/unfinished-work-item-unique-violation.js"
import { describe, expect, it } from "bun:test"

const uniqueError = (message: string, constraint: string): SqlError =>
  new SqlError({
    reason: new UniqueViolation({
      cause: new Error(message),
      message,
      constraint,
    }),
  })

describe("unfinished Work Item unique violations", () => {
  it("does not treat an Issue-index conflict as a concurrent CI Repair start", () => {
    const sqlite = uniqueError(
      "UNIQUE constraint failed: work_item.repository_id, work_item.issue_tracker, work_item.issue_native_id",
      "work_item.repository_id, work_item.issue_tracker, work_item.issue_native_id",
    )
    const postgres = uniqueError(
      'duplicate key value violates unique constraint "work_item_one_unfinished_v6_uidx"',
      "work_item_one_unfinished_v6_uidx",
    )
    const retired = uniqueError(
      "UNIQUE constraint failed: work_item.repository_id, work_item.issue_number",
      "work_item_one_unfinished_v4_uidx",
    )

    for (const error of [sqlite, postgres, retired]) {
      expect(isUnfinishedIssueWorkItemUniqueViolation(error)).toBe(true)
      expect(isUnfinishedCiRepairUniqueViolation(error)).toBe(false)
    }
  })

  it("recognizes a CI Repair index conflict on SQLite and Postgres", () => {
    const sqlite = uniqueError(
      "UNIQUE constraint failed: work_item.repository_id",
      "work_item.repository_id",
    )
    const postgres = uniqueError(
      'duplicate key value violates unique constraint "work_item_one_unfinished_ci_repair_uidx"',
      "work_item_one_unfinished_ci_repair_uidx",
    )

    for (const error of [sqlite, postgres]) {
      expect(isUnfinishedCiRepairUniqueViolation(error)).toBe(true)
      expect(isUnfinishedIssueWorkItemUniqueViolation(error)).toBe(false)
    }
  })
})
