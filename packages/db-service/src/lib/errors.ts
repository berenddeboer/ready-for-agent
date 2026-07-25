import { Schema } from "effect"

export class InvalidRepositoryInputError extends Schema.TaggedErrorClass<InvalidRepositoryInputError>()(
  "InvalidRepositoryInputError",
  {
    field: Schema.Literals(["githubOwner", "githubRepo", "localPath"]),
    message: Schema.String,
  },
) {}

export class RepositoryAlreadyExistsError extends Schema.TaggedErrorClass<RepositoryAlreadyExistsError>()(
  "RepositoryAlreadyExistsError",
  {
    githubOwner: Schema.String,
    githubRepo: Schema.String,
  },
) {}

export class LocalPathInUseError extends Schema.TaggedErrorClass<LocalPathInUseError>()(
  "LocalPathInUseError",
  {
    localPath: Schema.String,
  },
) {}

export class RepositoryNotFoundError extends Schema.TaggedErrorClass<RepositoryNotFoundError>()(
  "RepositoryNotFoundError",
  {
    repositoryId: Schema.String,
  },
) {}

export class RepositoryHasRunningStepError extends Schema.TaggedErrorClass<RepositoryHasRunningStepError>()(
  "RepositoryHasRunningStepError",
  {
    repositoryId: Schema.String,
    stepRunId: Schema.String,
    workItemId: Schema.String,
  },
) {}

export class InvalidIssueInputError extends Schema.TaggedErrorClass<InvalidIssueInputError>()(
  "InvalidIssueInputError",
  {
    field: Schema.Literals([
      "githubIssueNumber",
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

export class InvalidConfigInputError extends Schema.TaggedErrorClass<InvalidConfigInputError>()(
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
    ]),
    message: Schema.String,
  },
) {}

export class AgentBackendChangeBlockedError extends Schema.TaggedErrorClass<AgentBackendChangeBlockedError>()(
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

export class InvalidRepositorySettingsError extends Schema.TaggedErrorClass<InvalidRepositorySettingsError>()(
  "InvalidRepositorySettingsError",
  {
    field: Schema.Literals([
      "selectedAgentBackend",
      "defaultModel",
      "defaultThinkingLevel",
      "reviewModel",
      "reviewThinkingLevel",
    ]),
    message: Schema.String,
  },
) {}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
  "DatabaseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
