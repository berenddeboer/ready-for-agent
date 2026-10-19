import type { SqlError } from "effect/sql/SqlError"

/**
 * Unfinished Issue identity indexes. A CI Repair row is not in these indexes.
 * Names cover current and retired definitions so an in-flight error from either
 * dialect still classifies.
 */
const ISSUE_UNIQUE_INDEXES = [
  "work_item_one_unfinished_uidx",
  "work_item_one_unfinished_v2_uidx",
  "work_item_one_unfinished_v3_uidx",
  "work_item_one_unfinished_v4_uidx",
  "work_item_one_unfinished_v5_uidx",
  "work_item_one_unfinished_v6_uidx",
] as const

const CI_REPAIR_UNIQUE_INDEX = "work_item_one_unfinished_ci_repair_uidx"

const formatSqlError = (error: SqlError): string => {
  const parts: string[] = [error.message]
  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      if ("constraint" in current && typeof current.constraint === "string") {
        parts.push(current.constraint)
      }
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if (typeof obj["message"] === "string") {
        parts.push(obj["message"])
      }
      if (typeof obj["constraint"] === "string") {
        parts.push(obj["constraint"])
      }
      current = "cause" in obj ? obj["cause"] : undefined
    } else if (typeof current === "string") {
      parts.push(current)
      break
    } else {
      break
    }
  }
  return parts.join(" -> ")
}

const violationText = (error: SqlError): string => {
  const parts = [formatSqlError(error)]
  const reason = error.reason
  if (reason._tag === "UniqueViolation") {
    parts.push(reason.constraint)
    if (reason.message !== undefined) {
      parts.push(reason.message)
    }
  }
  return parts.join(" ").toLowerCase()
}

const isUniqueViolation = (error: SqlError, text: string): boolean =>
  error.reason._tag === "UniqueViolation" ||
  text.includes("unique") ||
  text.includes("sqlite_constraint") ||
  text.includes("duplicate key")

const mentionsIssueIndex = (text: string): boolean =>
  ISSUE_UNIQUE_INDEXES.some((name) => text.includes(name)) ||
  text.includes("issue_number") ||
  text.includes("issue_native_id")

/**
 * Unfinished Issue uniqueness (`work_item_one_unfinished_v6_uidx` and retired
 * Issue indexes). SQLite reports the columns; Postgres reports the constraint
 * name. A CI Repair index conflict is not an Issue conflict.
 */
export const isUnfinishedIssueWorkItemUniqueViolation = (
  error: SqlError,
): boolean => {
  const text = violationText(error)
  return isUniqueViolation(error, text) && mentionsIssueIndex(text)
}

/**
 * One unfinished CI Repair Work Item per Repository. An Issue-index conflict
 * is not a concurrent CI Repair start, on SQLite or Postgres.
 */
export const isUnfinishedCiRepairUniqueViolation = (
  error: SqlError,
): boolean => {
  const text = violationText(error)
  if (!isUniqueViolation(error, text)) {
    return false
  }
  if (isUnfinishedIssueWorkItemUniqueViolation(error)) {
    return false
  }
  return (
    text.includes(CI_REPAIR_UNIQUE_INDEX) ||
    text.includes("work_item.repository_id")
  )
}
