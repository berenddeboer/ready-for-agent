import { Schema } from "effect"

export class AcpSpawnError extends Schema.TaggedError<AcpSpawnError>()(
  "AcpSpawnError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AcpProcessExitError extends Schema.TaggedError<AcpProcessExitError>()(
  "AcpProcessExitError",
  {
    command: Schema.String,
    exitCode: Schema.NullOr(Schema.Finite),
    message: Schema.String,
  },
) {}

export class AcpProtocolError extends Schema.TaggedError<AcpProtocolError>()(
  "AcpProtocolError",
  {
    method: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type AcpClientError =
  | AcpSpawnError
  | AcpProcessExitError
  | AcpProtocolError
