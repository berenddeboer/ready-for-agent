import { Schema } from "effect"

export const RepositoryId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^repo-[0-9A-HJKMNP-TV-Z]{26}$/)),
  Schema.brand("RepositoryId"),
)
export type RepositoryId = typeof RepositoryId.Type

/** SQLite may return 0/1 or boolean depending on driver. */
const SqlBoolean = Schema.Union([Schema.Boolean, Schema.BooleanFromBit])

export const IssueState = Schema.Literals(["OPEN", "CLOSED"])
export type IssueState = typeof IssueState.Type

export const Forge = Schema.Literals(["github", "gitlab"])
export type Forge = typeof Forge.Type

export const IssueReference = Schema.Struct({
  issueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  issueUrl: Schema.String,
})
export type IssueReference = typeof IssueReference.Type

export type IssueDependency = IssueReference

export const AddRepositoryInput = Schema.Struct({
  forge: Forge,
  forgeHost: Schema.String,
  projectPath: Schema.String,
  localPath: Schema.String,
  isBare: Schema.Boolean,
})
export type AddRepositoryInput = typeof AddRepositoryInput.Type

export const RepositoryRecord = Schema.Struct({
  id: RepositoryId,
  forge: Forge,
  forgeHost: Schema.String,
  projectPath: Schema.String,
  localPath: Schema.String,
  isBare: Schema.Boolean,
  paused: Schema.Boolean,
  /**
   * Optional Agent Backend override. Null means inherit harness default.
   */
  selectedAgentBackend: Schema.NullOr(Schema.String),
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  autoMerge: Schema.Boolean,
  includeAllIssueAuthors: Schema.Boolean,
  waitForReadyForReviewChecks: Schema.Boolean,
  issuesReconciledAt: Schema.NullOr(Schema.Date),
})
export type RepositoryRecord = typeof RepositoryRecord.Type

export const UpdateRepositorySettingsInput = Schema.Struct({
  repositoryId: Schema.String,
  /** Omitted identity fields leave the persisted Forge identity unchanged. */
  forge: Schema.optionalKey(Forge),
  forgeHost: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  paused: Schema.Boolean,
  /**
   * Null clears the override (inherit harness default). Omitted leaves the
   * stored override unchanged so callers that do not yet send the field
   * (GraphQL until #467) do not wipe it.
   */
  selectedAgentBackend: Schema.optionalKey(Schema.NullOr(Schema.String)),
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  autoMerge: Schema.Boolean,
  includeAllIssueAuthors: Schema.Boolean,
  waitForReadyForReviewChecks: Schema.Boolean,
})
export type UpdateRepositorySettingsInput =
  typeof UpdateRepositorySettingsInput.Type

export const BackendModelPrefs = Schema.Struct({
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
})
export type BackendModelPrefs = typeof BackendModelPrefs.Type

export const emptyBackendModelPrefs = (): BackendModelPrefs => ({
  defaultModel: null,
  defaultThinkingLevel: null,
  reviewModel: null,
  reviewThinkingLevel: null,
})

export const ConfigRecord = Schema.Struct({
  selectedAgentBackend: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  maxConcurrentAgentTurns: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
  maxConcurrentWorkItems: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
})
export type ConfigRecord = typeof ConfigRecord.Type

export const UpdateConfigInput = Schema.Struct({
  selectedAgentBackend: Schema.String,
  /**
   * Build model for the selected backend. Required when keeping the same
   * backend (except empty first-run rows already null). Optional on backend
   * change so operators can hot-activate unconfigured.
   */
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  maxConcurrentAgentTurns: Schema.Finite,
  maxConcurrentWorkItems: Schema.Finite,
})
export type UpdateConfigInput = typeof UpdateConfigInput.Type

export const StoreIssueInput = Schema.Struct({
  repositoryId: Schema.String,
  issueNumber: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Date,
  issueAuthor: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(IssueReference),
  parentPosition: Schema.NullOr(Schema.Finite),
  hasChildren: Schema.Boolean,
  blockedBy: Schema.Array(IssueReference),
})
export type StoreIssueInput = typeof StoreIssueInput.Type

export const IssueRecord = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  issueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Date,
  issueAuthor: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(IssueReference),
  parentPosition: Schema.NullOr(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  hasChildren: Schema.Boolean,
  blockedBy: Schema.Array(IssueReference),
})
export type IssueRecord = typeof IssueRecord.Type

export const WorkItemPullRequest = Schema.Struct({
  issueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  pullRequestNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type WorkItemPullRequest = typeof WorkItemPullRequest.Type

export const UnfinishedCreatePrWorkItem = Schema.Struct({
  workItemId: Schema.String,
  issueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type UnfinishedCreatePrWorkItem = typeof UnfinishedCreatePrWorkItem.Type

/** Wire shape of `repository` SELECT rows (snake_case columns). */
export const RepositorySqlRow = Schema.Struct({
  id: RepositoryId,
  forge: Forge,
  forgeHost: Schema.String,
  projectPath: Schema.String,
  localPath: Schema.String,
  isBare: SqlBoolean,
  paused: SqlBoolean,
  selectedAgentBackend: Schema.NullOr(Schema.String),
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  backendModelPrefs: Schema.String,
  autoMerge: SqlBoolean,
  includeAllIssueAuthors: SqlBoolean,
  waitForReadyForReviewChecks: SqlBoolean,
  issuesReconciledAt: Schema.NullOr(Schema.DateFromMillis),
}).pipe(
  Schema.encodeKeys({
    forge: "forge",
    forgeHost: "forge_host",
    projectPath: "project_path",
    localPath: "local_path",
    isBare: "is_bare",
    selectedAgentBackend: "selected_agent_backend",
    defaultModel: "default_model",
    defaultThinkingLevel: "default_thinking_level",
    reviewModel: "review_model",
    reviewThinkingLevel: "review_thinking_level",
    backendModelPrefs: "backend_model_prefs",
    autoMerge: "auto_merge",
    includeAllIssueAuthors: "include_all_issue_authors",
    waitForReadyForReviewChecks: "wait_for_ready_for_review_checks",
    issuesReconciledAt: "issues_reconciled_at",
  }),
)
export type RepositorySqlRow = typeof RepositorySqlRow.Type

export const ConfigSqlRow = Schema.Struct({
  selectedAgentBackend: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  defaultThinkingLevel: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewThinkingLevel: Schema.NullOr(Schema.String),
  backendModelPrefs: Schema.String,
  maxConcurrentAgentTurns: Schema.Int,
  maxConcurrentWorkItems: Schema.Int,
}).pipe(
  Schema.encodeKeys({
    selectedAgentBackend: "selected_agent_backend",
    defaultModel: "default_model",
    defaultThinkingLevel: "default_thinking_level",
    reviewModel: "review_model",
    reviewThinkingLevel: "review_thinking_level",
    backendModelPrefs: "backend_model_prefs",
    maxConcurrentAgentTurns: "max_concurrent_agent_turns",
    maxConcurrentWorkItems: "max_concurrent_work_items",
  }),
)
export type ConfigSqlRow = typeof ConfigSqlRow.Type

export const IssueSqlRow = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  issueNumber: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Finite,
  issueAuthor: Schema.NullOr(Schema.String),
  parentIssueNumber: Schema.NullOr(Schema.Int),
  parentIssueUrl: Schema.NullOr(Schema.String),
  parentPosition: Schema.NullOr(Schema.Int),
  hasChildren: SqlBoolean,
}).pipe(
  Schema.encodeKeys({
    repositoryId: "repository_id",
    issueNumber: "issue_number",
    githubCreatedAt: "github_created_at",
    issueAuthor: "issue_author",
    parentIssueNumber: "parent_issue_number",
    parentIssueUrl: "parent_issue_url",
    parentPosition: "parent_position",
    hasChildren: "has_children",
  }),
)
export type IssueSqlRow = typeof IssueSqlRow.Type

export const IssueDependencySqlRow = Schema.Struct({
  issueId: Schema.String,
  issueNumber: Schema.Int,
  issueUrl: Schema.String,
}).pipe(
  Schema.encodeKeys({
    issueId: "issue_id",
    issueNumber: "blocking_issue_number",
    issueUrl: "blocking_issue_url",
  }),
)
export type IssueDependencySqlRow = typeof IssueDependencySqlRow.Type

export const WorkItemPullRequestSqlRow = Schema.Struct({
  issueNumber: Schema.Int,
  pullRequestNumber: Schema.Int,
}).pipe(
  Schema.encodeKeys({
    issueNumber: "issue_number",
    pullRequestNumber: "pull_request_number",
  }),
)
export type WorkItemPullRequestSqlRow = typeof WorkItemPullRequestSqlRow.Type

export const UnfinishedCreatePrWorkItemSqlRow = Schema.Struct({
  workItemId: Schema.String,
  issueNumber: Schema.Int,
}).pipe(
  Schema.encodeKeys({
    workItemId: "id",
    issueNumber: "issue_number",
  }),
)
export type UnfinishedCreatePrWorkItemSqlRow =
  typeof UnfinishedCreatePrWorkItemSqlRow.Type

export const RunningStepSqlRow = Schema.Struct({
  stepRunId: Schema.String,
  workItemId: Schema.String,
}).pipe(
  Schema.encodeKeys({
    stepRunId: "step_run_id",
    workItemId: "work_item_id",
  }),
)
export type RunningStepSqlRow = typeof RunningStepSqlRow.Type
