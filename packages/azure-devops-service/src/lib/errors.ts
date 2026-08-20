import { Schema } from "effect"

export class AzureDevOpsProjectUnavailableError extends Schema.TaggedErrorClass<AzureDevOpsProjectUnavailableError>()(
  "AzureDevOpsProjectUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

export class AzureDevOpsRequestError extends Schema.TaggedErrorClass<AzureDevOpsRequestError>()(
  "AzureDevOpsRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
    /**
     * Machine-readable discriminator lifted from the nested cause chain
     * when available (e.g. TLS or DNS codes).
     */
    code: Schema.optional(Schema.String),
  },
) {}

/**
 * A service method not yet implemented against the real Azure DevOps REST
 * API. Every method on {@link AzureDevOpsServiceShape} is implemented except
 * `countOpenNonDraftPullRequests`, which fails with this error until a later
 * ticket builds it out.
 */
export class AzureDevOpsNotImplementedError extends Schema.TaggedErrorClass<AzureDevOpsNotImplementedError>()(
  "AzureDevOpsNotImplementedError",
  {
    method: Schema.String,
  },
) {}
