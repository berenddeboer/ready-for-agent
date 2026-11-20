import { Schema } from "effect"

/**
 * Why an fp CLI invocation failed, when known. `issue_not_found` lets
 * discovery drop one vanished Issue instead of failing the poll;
 * `invalid_status` belongs to the execution half (status writes).
 */
export const FpFailureKind = Schema.Literals([
  "project_not_registered",
  "issue_not_found",
  "invalid_status",
  "timeout",
  "spawn_failed",
  "unreadable_output",
  "unknown",
])
export type FpFailureKind = typeof FpFailureKind.Type

/** An fp CLI invocation failed, timed out, or returned output we cannot read. */
export class FpRequestError extends Schema.TaggedErrorClass<FpRequestError>()(
  "FpRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Finite),
    stderr: Schema.optional(Schema.String),
    kind: Schema.optional(FpFailureKind),
  },
) {}

/** For the execution half: a Repository selects fp without a usable project. */
export class FpNotConfiguredError extends Schema.TaggedErrorClass<FpNotConfiguredError>()(
  "FpNotConfiguredError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}
