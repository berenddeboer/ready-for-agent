import { Schema } from "effect"

export class AcpSpawnError extends Schema.TaggedErrorClass<AcpSpawnError>()(
  "AcpSpawnError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AcpProcessExitError extends Schema.TaggedErrorClass<AcpProcessExitError>()(
  "AcpProcessExitError",
  {
    command: Schema.String,
    exitCode: Schema.NullOr(Schema.Finite),
    message: Schema.String,
  },
) {}

export class AcpProtocolError extends Schema.TaggedErrorClass<AcpProtocolError>()(
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
