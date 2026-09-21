import { Schema } from "effect"
import type {
  LinearNotConfiguredError,
  LinearRequestError,
} from "@ready-for-agent/linear-service"

export class CloseIssueSummaryMissingError extends Schema.TaggedErrorClass<CloseIssueSummaryMissingError>()(
  "CloseIssueSummaryMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CloseIssueContextError extends Schema.TaggedErrorClass<CloseIssueContextError>()(
  "CloseIssueContextError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CloseIssueEligibilityError extends Schema.TaggedErrorClass<CloseIssueEligibilityError>()(
  "CloseIssueEligibilityError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    failureCode: Schema.String,
  },
) {}

export type CloseIssueError =
  | CloseIssueSummaryMissingError
  | CloseIssueContextError
  | CloseIssueEligibilityError
  | LinearRequestError
  | LinearNotConfiguredError
