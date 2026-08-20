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
 * API. `verifyProject`, `getAuthenticatedUserLogin`, `hasCredentials`,
 * `hasAmbientCredentials`, `getOpenPullRequestNumber`,
 * `findOpenPullRequestNumber`, `createDraftPullRequest`,
 * `updateOpenDraftPullRequestCopy`, and `markPullRequestReadyForReview` are
 * implemented; the remaining 9 methods on {@link AzureDevOpsServiceShape}
 * fail with this error until later tickets build them out (merge state
 * machine, Ready Issue listing, etc.).
 */
export class AzureDevOpsNotImplementedError extends Schema.TaggedErrorClass<AzureDevOpsNotImplementedError>()(
  "AzureDevOpsNotImplementedError",
  {
    method: Schema.String,
  },
) {}
