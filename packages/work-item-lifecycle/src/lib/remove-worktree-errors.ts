import { Schema } from "effect"

export class RemoveWorktreeCredentialError extends Schema.TaggedError<RemoveWorktreeCredentialError>()(
  "RemoveWorktreeCredentialError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class RemoveWorktreeRemoteError extends Schema.TaggedError<RemoveWorktreeRemoteError>()(
  "RemoveWorktreeRemoteError",
  {
    message: Schema.String,
    branchName: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
