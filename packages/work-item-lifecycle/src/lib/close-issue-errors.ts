import { Data } from "effect"

export class CloseIssueSummaryMissingError extends Data.TaggedError(
  "CloseIssueSummaryMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CloseIssueContextError extends Data.TaggedError(
  "CloseIssueContextError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CloseIssueEligibilityError extends Data.TaggedError(
  "CloseIssueEligibilityError",
)<{
  readonly workItemId: string
  readonly message: string
  readonly failureCode: string
}> {}

export type CloseIssueError =
  | CloseIssueSummaryMissingError
  | CloseIssueContextError
  | CloseIssueEligibilityError
