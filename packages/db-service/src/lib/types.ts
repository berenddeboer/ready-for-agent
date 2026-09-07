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

export const Forge = Schema.Literals(["github", "gitlab", "azure-devops"])
export type Forge = typeof Forge.Type

export const MergePolicy = Schema.Literals(["off", "classify", "always"])
export type MergePolicy = typeof MergePolicy.Type

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
  mergePolicy: MergePolicy,
  /**
   * Optional guaranteed-minimum concurrent Agent Turns floor. Null means no
   * guarantee (fully fair-share).
   */
  guaranteedMinConcurrentAgentTurns: Schema.NullOr(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  includeAllIssueAuthors: Schema.Boolean,
  waitForReadyForReviewChecks: Schema.Boolean,
  issuesReconciledAt: Schema.NullOr(Schema.Date),
})
export type RepositoryRecord = typeof RepositoryRecord.Type

export const CiGateDefinitionRecord = Schema.Struct({
  identity: Schema.String,
  displayLabel: Schema.String,
  kind: Schema.String,
  diagnosticMetadata: Schema.NullOr(Schema.String),
})
export type CiGateDefinitionRecord = typeof CiGateDefinitionRecord.Type

export const CiGateRecoveryReason = Schema.Literals([
  "newer_success",
  "definition_removed",
  "empty_selection",
  "default_branch_changed",
])
export type CiGateRecoveryReason = typeof CiGateRecoveryReason.Type

export const CiGateObservationErrorKind = Schema.Literals([
  "permission",
  "not_found",
  "error",
])
export type CiGateObservationErrorKind = typeof CiGateObservationErrorKind.Type

export const CiGateStateRecord = Schema.Struct({
  repositoryId: RepositoryId,
  defaultBranch: Schema.NullOr(Schema.String),
  lastObservedAt: Schema.NullOr(Schema.Date),
})
export type CiGateStateRecord = typeof CiGateStateRecord.Type

export const CiGateDefinitionObservationRecord = Schema.Struct({
  identity: Schema.String,
  lastObservedAt: Schema.NullOr(Schema.Date),
  lastRunIdentity: Schema.NullOr(Schema.String),
  lastRunHtmlUrl: Schema.NullOr(Schema.String),
  lastHeadSha: Schema.NullOr(Schema.String),
  lastHeadRef: Schema.NullOr(Schema.String),
  lastEvent: Schema.NullOr(Schema.String),
  lastRawStatus: Schema.NullOr(Schema.String),
  lastRawConclusion: Schema.NullOr(Schema.String),
  lastRunCreatedAt: Schema.NullOr(Schema.Date),
  lastRunUpdatedAt: Schema.NullOr(Schema.Date),
  failureLatched: Schema.Boolean,
  latchedRunIdentity: Schema.NullOr(Schema.String),
  latchedRunHtmlUrl: Schema.NullOr(Schema.String),
  observationError: Schema.NullOr(Schema.String),
  observationErrorKind: Schema.NullOr(CiGateObservationErrorKind),
})
export type CiGateDefinitionObservationRecord =
  typeof CiGateDefinitionObservationRecord.Type

export const CiFailureIncidentDefinitionRecord = Schema.Struct({
  identity: Schema.String,
  displayLabel: Schema.String,
  firstFailedRunIdentity: Schema.NullOr(Schema.String),
  firstFailedRunHtmlUrl: Schema.NullOr(Schema.String),
  joinedAt: Schema.Date,
})
export type CiFailureIncidentDefinitionRecord =
  typeof CiFailureIncidentDefinitionRecord.Type

export const CiFailureIncidentRecord = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  status: Schema.Literals(["open", "resolved"]),
  openedAt: Schema.Date,
  resolvedAt: Schema.NullOr(Schema.Date),
  recoveryReason: Schema.NullOr(CiGateRecoveryReason),
  summary: Schema.String,
  definitions: Schema.Array(CiFailureIncidentDefinitionRecord),
})
export type CiFailureIncidentRecord = typeof CiFailureIncidentRecord.Type

export const CiRepairSourceAction = Schema.Literals([
  "implement_ci_repair",
  "authorize_as_ci_repair",
])
export type CiRepairSourceAction = typeof CiRepairSourceAction.Type

export const CiRepairAuthorizationRecord = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  workItemId: Schema.String,
  sourceAction: CiRepairSourceAction,
  authorizedAt: Schema.Date,
  incident: CiFailureIncidentRecord,
})
export type CiRepairAuthorizationRecord =
  typeof CiRepairAuthorizationRecord.Type

export const CiGateSnapshotRecord = Schema.Struct({
  state: Schema.NullOr(CiGateStateRecord),
  observations: Schema.Array(CiGateDefinitionObservationRecord),
  activeIncident: Schema.NullOr(CiFailureIncidentRecord),
  latestResolvedIncident: Schema.NullOr(CiFailureIncidentRecord),
})
export type CiGateSnapshotRecord = typeof CiGateSnapshotRecord.Type

export const CommitCiGateSnapshotInput = Schema.Struct({
  repositoryId: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  lastObservedAt: Schema.NullOr(Schema.Date),
  observations: Schema.Array(CiGateDefinitionObservationRecord),
  incidentsToUpsert: Schema.Array(CiFailureIncidentRecord),
})
export type CommitCiGateSnapshotInput = typeof CommitCiGateSnapshotInput.Type

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
  mergePolicy: MergePolicy,
  /**
   * Null clears the guarantee (fully fair-share). Omitted leaves the stored
   * guarantee unchanged so callers that do not yet send the field do not
   * clear it.
   */
  guaranteedMinConcurrentAgentTurns: Schema.optionalKey(
    Schema.NullOr(Schema.Finite),
  ),
  includeAllIssueAuthors: Schema.Boolean,
  waitForReadyForReviewChecks: Schema.Boolean,
  /**
   * Selected CI Gate Definitions. Omitted leaves stored selections unchanged.
   * Empty array clears every selection and disables the Repository CI Gate.
   */
  selectedCiGateDefinitions: Schema.optionalKey(
    Schema.Array(CiGateDefinitionRecord),
  ),
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
  mergePolicy: MergePolicy,
  guaranteedMinConcurrentAgentTurns: Schema.NullOr(Schema.Int),
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
    mergePolicy: "merge_policy",
    guaranteedMinConcurrentAgentTurns: "guaranteed_min_concurrent_agent_turns",
    includeAllIssueAuthors: "include_all_issue_authors",
    waitForReadyForReviewChecks: "wait_for_ready_for_review_checks",
    issuesReconciledAt: "issues_reconciled_at",
  }),
)
export type RepositorySqlRow = typeof RepositorySqlRow.Type

export const CiGateDefinitionSqlRow = Schema.Struct({
  identity: Schema.String,
  displayLabel: Schema.String,
  kind: Schema.String,
  diagnosticMetadata: Schema.NullOr(Schema.String),
}).pipe(
  Schema.encodeKeys({
    displayLabel: "display_label",
    diagnosticMetadata: "diagnostic_metadata",
  }),
)
export type CiGateDefinitionSqlRow = typeof CiGateDefinitionSqlRow.Type

export const CiGateStateSqlRow = Schema.Struct({
  repositoryId: RepositoryId,
  defaultBranch: Schema.NullOr(Schema.String),
  lastObservedAt: Schema.NullOr(Schema.DateFromMillis),
}).pipe(
  Schema.encodeKeys({
    repositoryId: "repository_id",
    defaultBranch: "default_branch",
    lastObservedAt: "last_observed_at",
  }),
)
export type CiGateStateSqlRow = typeof CiGateStateSqlRow.Type

export const CiGateDefinitionObservationSqlRow = Schema.Struct({
  identity: Schema.String,
  lastObservedAt: Schema.NullOr(Schema.DateFromMillis),
  lastRunIdentity: Schema.NullOr(Schema.String),
  lastRunHtmlUrl: Schema.NullOr(Schema.String),
  lastHeadSha: Schema.NullOr(Schema.String),
  lastHeadRef: Schema.NullOr(Schema.String),
  lastEvent: Schema.NullOr(Schema.String),
  lastRawStatus: Schema.NullOr(Schema.String),
  lastRawConclusion: Schema.NullOr(Schema.String),
  lastRunCreatedAt: Schema.NullOr(Schema.DateFromMillis),
  lastRunUpdatedAt: Schema.NullOr(Schema.DateFromMillis),
  failureLatched: SqlBoolean,
  latchedRunIdentity: Schema.NullOr(Schema.String),
  latchedRunHtmlUrl: Schema.NullOr(Schema.String),
  observationError: Schema.NullOr(Schema.String),
  observationErrorKind: Schema.NullOr(CiGateObservationErrorKind),
}).pipe(
  Schema.encodeKeys({
    identity: "definition_identity",
    lastObservedAt: "last_observed_at",
    lastRunIdentity: "last_run_identity",
    lastRunHtmlUrl: "last_run_html_url",
    lastHeadSha: "last_head_sha",
    lastHeadRef: "last_head_ref",
    lastEvent: "last_event",
    lastRawStatus: "last_raw_status",
    lastRawConclusion: "last_raw_conclusion",
    lastRunCreatedAt: "last_run_created_at",
    lastRunUpdatedAt: "last_run_updated_at",
    failureLatched: "failure_latched",
    latchedRunIdentity: "latched_run_identity",
    latchedRunHtmlUrl: "latched_run_html_url",
    observationError: "observation_error",
    observationErrorKind: "observation_error_kind",
  }),
)
export type CiGateDefinitionObservationSqlRow =
  typeof CiGateDefinitionObservationSqlRow.Type

export const CiFailureIncidentSqlRow = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  status: Schema.Literals(["open", "resolved"]),
  openedAt: Schema.DateFromMillis,
  resolvedAt: Schema.NullOr(Schema.DateFromMillis),
  recoveryReason: Schema.NullOr(CiGateRecoveryReason),
  summary: Schema.String,
}).pipe(
  Schema.encodeKeys({
    repositoryId: "repository_id",
    openedAt: "opened_at",
    resolvedAt: "resolved_at",
    recoveryReason: "recovery_reason",
  }),
)
export type CiFailureIncidentSqlRow = typeof CiFailureIncidentSqlRow.Type

export const CiFailureIncidentDefinitionSqlRow = Schema.Struct({
  identity: Schema.String,
  displayLabel: Schema.String,
  firstFailedRunIdentity: Schema.NullOr(Schema.String),
  firstFailedRunHtmlUrl: Schema.NullOr(Schema.String),
  joinedAt: Schema.DateFromMillis,
}).pipe(
  Schema.encodeKeys({
    identity: "definition_identity",
    displayLabel: "display_label",
    firstFailedRunIdentity: "first_failed_run_identity",
    firstFailedRunHtmlUrl: "first_failed_run_html_url",
    joinedAt: "joined_at",
  }),
)
export type CiFailureIncidentDefinitionSqlRow =
  typeof CiFailureIncidentDefinitionSqlRow.Type

export const CiRepairAuthorizationSqlRow = Schema.Struct({
  id: Schema.String,
  repositoryId: RepositoryId,
  workItemId: Schema.String,
  incidentId: Schema.String,
  sourceAction: CiRepairSourceAction,
  authorizedAt: Schema.DateFromMillis,
}).pipe(
  Schema.encodeKeys({
    repositoryId: "repository_id",
    workItemId: "work_item_id",
    incidentId: "incident_id",
    sourceAction: "source_action",
    authorizedAt: "authorized_at",
  }),
)
export type CiRepairAuthorizationSqlRow =
  typeof CiRepairAuthorizationSqlRow.Type

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

export const GuaranteedMinSumSqlRow = Schema.Struct({
  sum: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type GuaranteedMinSumSqlRow = typeof GuaranteedMinSumSqlRow.Type

export const RepositorySettingsConfigSqlRow = Schema.Struct({
  selectedAgentBackend: Schema.String,
  maxConcurrentAgentTurns: Schema.Int,
})
export type RepositorySettingsConfigSqlRow =
  typeof RepositorySettingsConfigSqlRow.Type

export const RepositorySettingsSqlRow = Schema.Struct({
  forge: Forge,
  forgeHost: Schema.String,
  projectPath: Schema.String,
  selectedAgentBackend: Schema.NullOr(Schema.String),
  backendModelPrefs: Schema.String,
  guaranteedMinConcurrentAgentTurns: Schema.NullOr(Schema.Int),
})
export type RepositorySettingsSqlRow = typeof RepositorySettingsSqlRow.Type

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
