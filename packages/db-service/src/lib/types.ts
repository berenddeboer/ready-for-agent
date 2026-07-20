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

export const IssueReference = Schema.Struct({
  githubIssueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  githubIssueUrl: Schema.String,
})
export type IssueReference = typeof IssueReference.Type

export type IssueDependency = IssueReference

export const AddRepositoryInput = Schema.Struct({
  githubOwner: Schema.String,
  githubRepo: Schema.String,
  localPath: Schema.String,
  isBare: Schema.Boolean,
})
export type AddRepositoryInput = typeof AddRepositoryInput.Type

export const RepositoryRecord = Schema.Struct({
  id: RepositoryId,
  githubOwner: Schema.String,
  githubRepo: Schema.String,
  localPath: Schema.String,
  isBare: Schema.Boolean,
  paused: Schema.Boolean,
  defaultModel: Schema.NullOr(Schema.String),
  defaultVariant: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  autoMerge: Schema.Boolean,
  issuesReconciledAt: Schema.NullOr(Schema.Date),
})
export type RepositoryRecord = typeof RepositoryRecord.Type

export const UpdateRepositorySettingsInput = Schema.Struct({
  repositoryId: Schema.String,
  paused: Schema.Boolean,
  defaultModel: Schema.NullOr(Schema.String),
  defaultVariant: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  autoMerge: Schema.Boolean,
})
export type UpdateRepositorySettingsInput =
  typeof UpdateRepositorySettingsInput.Type

export const ConfigRecord = Schema.Struct({
  defaultModel: Schema.NullOr(Schema.String),
  defaultVariant: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  maxConcurrentOpencodeSessions: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
  maxConcurrentWorkItems: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
})
export type ConfigRecord = typeof ConfigRecord.Type

export const UpdateConfigInput = Schema.Struct({
  defaultModel: Schema.String,
  defaultVariant: Schema.String,
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  maxConcurrentOpencodeSessions: Schema.Finite,
  maxConcurrentWorkItems: Schema.Finite,
})
export type UpdateConfigInput = typeof UpdateConfigInput.Type

export const StoreIssueInput = Schema.Struct({
  repositoryId: Schema.String,
  githubIssueNumber: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Date,
  parent: Schema.NullOr(IssueReference),
  parentPosition: Schema.NullOr(Schema.Finite),
  hasChildren: Schema.Boolean,
  blockedBy: Schema.Array(IssueReference),
})
export type StoreIssueInput = typeof StoreIssueInput.Type

export const IssueRecord = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  githubIssueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Date,
  parent: Schema.NullOr(IssueReference),
  parentPosition: Schema.NullOr(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  hasChildren: Schema.Boolean,
  blockedBy: Schema.Array(IssueReference),
})
export type IssueRecord = typeof IssueRecord.Type

export const WorkItemPullRequest = Schema.Struct({
  githubIssueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  githubPullRequestNumber: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
})
export type WorkItemPullRequest = typeof WorkItemPullRequest.Type

/** Wire shape of `repository` SELECT rows (snake_case columns). */
export const RepositorySqlRow = Schema.Struct({
  id: RepositoryId,
  githubOwner: Schema.String,
  githubRepo: Schema.String,
  localPath: Schema.String,
  isBare: SqlBoolean,
  paused: SqlBoolean,
  defaultModel: Schema.NullOr(Schema.String),
  defaultVariant: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  autoMerge: SqlBoolean,
  issuesReconciledAt: Schema.NullOr(Schema.DateFromMillis),
}).pipe(
  Schema.encodeKeys({
    githubOwner: "github_owner",
    githubRepo: "github_repo",
    localPath: "local_path",
    isBare: "is_bare",
    defaultModel: "default_model",
    defaultVariant: "default_variant",
    reviewModel: "review_model",
    reviewVariant: "review_variant",
    autoMerge: "auto_merge",
    issuesReconciledAt: "issues_reconciled_at",
  }),
)
export type RepositorySqlRow = typeof RepositorySqlRow.Type

export const ConfigSqlRow = Schema.Struct({
  defaultModel: Schema.NullOr(Schema.String),
  defaultVariant: Schema.NullOr(Schema.String),
  reviewModel: Schema.NullOr(Schema.String),
  reviewVariant: Schema.NullOr(Schema.String),
  maxConcurrentOpencodeSessions: Schema.Int,
  maxConcurrentWorkItems: Schema.Int,
}).pipe(
  Schema.encodeKeys({
    defaultModel: "default_model",
    defaultVariant: "default_variant",
    reviewModel: "review_model",
    reviewVariant: "review_variant",
    maxConcurrentOpencodeSessions: "max_concurrent_opencode_sessions",
    maxConcurrentWorkItems: "max_concurrent_work_items",
  }),
)
export type ConfigSqlRow = typeof ConfigSqlRow.Type

export const IssueSqlRow = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  githubIssueNumber: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: IssueState,
  githubCreatedAt: Schema.Finite,
  parentGithubIssueNumber: Schema.NullOr(Schema.Int),
  parentGithubIssueUrl: Schema.NullOr(Schema.String),
  parentPosition: Schema.NullOr(Schema.Int),
  hasChildren: SqlBoolean,
}).pipe(
  Schema.encodeKeys({
    repositoryId: "repository_id",
    githubIssueNumber: "github_issue_number",
    githubCreatedAt: "github_created_at",
    parentGithubIssueNumber: "parent_github_issue_number",
    parentGithubIssueUrl: "parent_github_issue_url",
    parentPosition: "parent_position",
    hasChildren: "has_children",
  }),
)
export type IssueSqlRow = typeof IssueSqlRow.Type

export const IssueDependencySqlRow = Schema.Struct({
  issueId: Schema.String,
  githubIssueNumber: Schema.Int,
  githubIssueUrl: Schema.String,
}).pipe(
  Schema.encodeKeys({
    issueId: "issue_id",
    githubIssueNumber: "blocking_github_issue_number",
    githubIssueUrl: "blocking_github_issue_url",
  }),
)
export type IssueDependencySqlRow = typeof IssueDependencySqlRow.Type

export const WorkItemPullRequestSqlRow = Schema.Struct({
  githubIssueNumber: Schema.Int,
  githubPullRequestNumber: Schema.Int,
}).pipe(
  Schema.encodeKeys({
    githubIssueNumber: "github_issue_number",
    githubPullRequestNumber: "github_pull_request_number",
  }),
)
export type WorkItemPullRequestSqlRow = typeof WorkItemPullRequestSqlRow.Type

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
