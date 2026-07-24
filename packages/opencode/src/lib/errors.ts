import { Schema } from "effect"

/** @deprecated Prefer AgentBackendConfigError from @ready-for-agent/agent-backend */
export class OpencodeConfigError extends Schema.TaggedErrorClass<OpencodeConfigError>()(
  "OpencodeConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
