import { Schema } from "effect"

export class InvalidRepositoryInputError extends Schema.TaggedError<InvalidRepositoryInputError>()(
  "InvalidRepositoryInputError",
  {
    field: Schema.Literals(["forge", "forgeHost", "projectPath", "localPath"]),
    message: Schema.String,
  },
) {}

export class RepositoryAlreadyExistsError extends Schema.TaggedError<RepositoryAlreadyExistsError>()(
  "RepositoryAlreadyExistsError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

export class LocalPathInUseError extends Schema.TaggedError<LocalPathInUseError>()(
  "LocalPathInUseError",
  {
    localPath: Schema.String,
  },
) {}

export class RepositoryNotFoundError extends Schema.TaggedError<RepositoryNotFoundError>()(
  "RepositoryNotFoundError",
  {
    repositoryId: Schema.String,
  },
) {}

export class RepositoryHasRunningStepError extends Schema.TaggedError<RepositoryHasRunningStepError>()(
  "RepositoryHasRunningStepError",
  {
    repositoryId: Schema.String,
    stepRunId: Schema.String,
    workItemId: Schema.String,
  },
) {}

export class InvalidIssueInputError extends Schema.TaggedError<InvalidIssueInputError>()(
  "InvalidIssueInputError",
  {
    field: Schema.Literals([
      "issueNumber",
      "issueTracker",
      "nativeId",
      "displayId",
      "title",
      "url",
      "state",
      "githubCreatedAt",
      "parent",
      "parentPosition",
      "blockedBy",
    ]),
    message: Schema.String,
  },
) {}

export class InvalidConfigInputError extends Schema.TaggedError<InvalidConfigInputError>()(
  "InvalidConfigInputError",
  {
    field: Schema.Literals([
      "selectedAgentBackend",
      "defaultModel",
      "defaultThinkingLevel",
      "reviewModel",
      "reviewThinkingLevel",
      "maxConcurrentAgentTurns",
      "maxConcurrentWorkItems",
      "providerRecoveryMaxWaitMs",
    ]),
    message: Schema.String,
  },
) {}

export class AgentBackendChangeBlockedError extends Schema.TaggedError<AgentBackendChangeBlockedError>()(
  "AgentBackendChangeBlockedError",
  {
    message: Schema.String,
    /**
     * Work Items that block this change (scoped gate), not fleet total
     * unfinished. Kept as unfinishedWorkItemCount for GraphQL extension
     * compatibility.
     */
    unfinishedWorkItemCount: Schema.Finite,
    /** Where the unfinished Work Items that block this change live. */
    scope: Schema.Literals(["global", "repository"]),
    /** Set when scope is repository. */
    repositoryId: Schema.optional(Schema.String),
  },
) {}

export class RepositoryIdentityChangeBlockedError extends Schema.TaggedError<RepositoryIdentityChangeBlockedError>()(
  "RepositoryIdentityChangeBlockedError",
  {
    repositoryId: Schema.String,
    workItemCount: Schema.Int,
    message: Schema.String,
  },
) {}

export class InvalidRepositorySettingsError extends Schema.TaggedError<InvalidRepositorySettingsError>()(
  "InvalidRepositorySettingsError",
  {
    field: Schema.Literals([
      "forge",
      "forgeHost",
      "projectPath",
      "selectedAgentBackend",
      "defaultModel",
      "defaultThinkingLevel",
      "reviewModel",
      "reviewThinkingLevel",
      "guaranteedMinConcurrentAgentTurns",
      "selectedCiGateDefinitionIdentities",
      "issueTracker",
      "linearProjectId",
      "linearWorkflowStatuses",
      "automaticCiRepair",
    ]),
    message: Schema.String,
  },
) {}

/**
 * Rejects a Config or Repository settings write that would make the sum of
 * all Repositories' guaranteed-minimum concurrent Agent Turns exceed the
 * effective harness-wide `maxConcurrentAgentTurns` cap — whether the write
 * raises/adds a Repository guarantee or lowers the global cap below the
 * current total of guarantees.
 */
export class GuaranteedMinAgentTurnsExceedsCapError extends Schema.TaggedError<GuaranteedMinAgentTurnsExceedsCapError>()(
  "GuaranteedMinAgentTurnsExceedsCapError",
  {
    message: Schema.String,
    maxConcurrentAgentTurns: Schema.Int,
    sumOfGuaranteedMinConcurrentAgentTurns: Schema.Int,
  },
) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
