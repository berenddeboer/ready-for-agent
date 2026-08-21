import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  Config,
  Duration,
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
} from "effect"
import {
  type MergePullRequestResult,
  type PrStatusCheckDiagnostic,
  type PullRequestCheckStatus,
  type PullRequestLifecycleStatus,
  type PullRequestMergeability,
  type TerminalPrStatusCheck,
  extractErrorCode,
} from "@ready-for-agent/github-service"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceError,
  type AzureDevOpsServiceShape,
} from "./azure-devops-service.js"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
} from "./errors.js"
import {
  AZURE_DEVOPS_FORGE_HOST,
  AZURE_DEVOPS_PAT_ENV_VAR,
  type AzureDevOpsProjectIdentity,
  type AzureDevOpsReadyLabeledIssue,
  type AzureDevOpsRepository,
  azureDevOpsRepositoryName,
  splitAzureDevOpsProjectPath,
} from "./types.js"

const REQUEST_TIMEOUT = Duration.seconds(30)
/** Azure DevOps REST API version pinned for stable response shapes. */
const API_VERSION = "7.1"
/**
 * The Work Item Comments surface (`_apis/wit/workitems/{id}/comments`) is not
 * exposed on the stable `7.1` API version; it requires this preview version.
 * See {@link requestUnknown}'s `apiVersion` override.
 */
const COMMENTS_API_VERSION = "7.1-preview.3"
/**
 * `_apis/connectionData` is a legacy endpoint not exposed on the stable
 * `7.1` API version; it requires the preview flag even though it returns
 * stable-shaped data. See {@link requestUnknown}'s `apiVersion` override.
 */
const CONNECTION_DATA_API_VERSION = "7.1-preview"
/**
 * `_apis/policy/evaluations` (both the list and single-evaluation shapes) is
 * not exposed on the stable `7.1` API version; it requires the preview flag
 * even though its response shape is stable. See {@link requestUnknown}'s
 * `apiVersion` override.
 */
const POLICY_EVALUATIONS_API_VERSION = "7.1-preview"

type AzureDevOpsFetch = typeof fetch

class AzureDevOpsHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)

const ProjectSchema = Schema.Struct({
  id: Schema.optional(RequiredString),
  name: RequiredString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const ConnectionDataSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({
    id: Schema.optional(Schema.String),
    /**
     * The Entra/AAD directory display name — can differ from the ADO-native
     * `customDisplayName` for the same account (e.g. "Christopher Barlow" vs
     * "Chris Barlow"). Never used alone for author matching; see
     * {@link resolveAuthenticatedUserLogin}.
     */
    providerDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
    /**
     * The ADO-native display name — matches `System.CreatedBy.displayName`
     * on work items authored by this account, unlike `providerDisplayName`.
     */
    customDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

const CommitRefSchema = Schema.Struct({
  commitId: Schema.optional(Schema.NullOr(Schema.String)),
})

const ProjectRefSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
})

const RepositoryRefSchema = Schema.Struct({
  project: Schema.optional(Schema.NullOr(ProjectRefSchema)),
})

const PullRequestSchema = Schema.Struct({
  pullRequestId: PositiveInt,
  status: Schema.optional(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  sourceRefName: Schema.optional(Schema.NullOr(Schema.String)),
  targetRefName: Schema.optional(Schema.NullOr(Schema.String)),
  /** `notSet`|`queued`|`conflicts`|`succeeded`|`failure`|`rejectedByPolicy`. */
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  lastMergeSourceCommit: Schema.optional(Schema.NullOr(CommitRefSchema)),
  creationDate: Schema.optional(Schema.NullOr(Schema.String)),
  /** Present on the full PR resource; used to build the policy artifact id. */
  repository: Schema.optional(Schema.NullOr(RepositoryRefSchema)),
})
type AzureDevOpsPullRequest = typeof PullRequestSchema.Type

const PullRequestListSchema = Schema.Struct({
  value: Schema.Array(PullRequestSchema),
})

const RepositoryMetaSchema = Schema.Struct({
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
})

/** One `GET .../policy/evaluations` entry (branch policy, including build validation). */
const PolicyEvaluationSchema = Schema.Struct({
  evaluationId: RequiredString,
  /** `approved`|`rejected`|`queued`|`running`|`notApplicable`|`broken`. */
  status: RequiredString,
  configuration: Schema.optional(
    Schema.Struct({
      type: Schema.optional(
        Schema.Struct({
          displayName: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
  context: Schema.optional(
    Schema.Struct({
      buildId: Schema.optional(Schema.NullOr(Schema.Int)),
    }),
  ),
})
type AzureDevOpsPolicyEvaluation = typeof PolicyEvaluationSchema.Type

const PolicyEvaluationListSchema = Schema.Struct({
  value: Schema.Array(PolicyEvaluationSchema),
})

/** One `GET .../pullrequests/{id}/statuses` entry (custom PR status context). */
const PrStatusSchema = Schema.Struct({
  id: Schema.optional(Schema.Int),
  /** `notApplicable`|`error`|`pending`|`succeeded`|`failed`. */
  state: RequiredString,
  context: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.NullOr(Schema.String)),
      genre: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})
type AzureDevOpsPrStatus = typeof PrStatusSchema.Type

const PrStatusListSchema = Schema.Struct({
  value: Schema.Array(PrStatusSchema),
})

const CommitMetaSchema = Schema.Struct({
  committer: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ date: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ date: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
})

const BuildLogSchema = Schema.Struct({ id: PositiveInt })
const BuildLogListSchema = Schema.Struct({
  value: Schema.Array(BuildLogSchema),
})

const RefSchema = Schema.Struct({
  name: RequiredString,
  objectId: RequiredString,
})
const RefListSchema = Schema.Struct({ value: Schema.Array(RefSchema) })

const RefUpdateResultSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  updateStatus: Schema.optional(Schema.NullOr(Schema.String)),
})
const RefUpdateListSchema = Schema.Struct({
  value: Schema.Array(RefUpdateResultSchema),
})

/** Azure DevOps zero SHA sentinel used to request a ref delete. */
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000"

const CommentSchema = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
})
const CommentListSchema = Schema.Struct({
  comments: Schema.Array(CommentSchema),
})

const WorkItemStateFieldsSchema = Schema.Struct({
  "System.State": Schema.optional(Schema.String),
  "System.WorkItemType": Schema.optional(Schema.String),
})
const WorkItemStateSchema = Schema.Struct({
  id: Schema.Int,
  fields: WorkItemStateFieldsSchema,
})

const WorkItemTypeStateSchema = Schema.Struct({
  name: RequiredString,
  /** `Proposed`|`InProgress`|`Resolved`|`Completed`|`Removed` (process-dependent). */
  category: Schema.optional(Schema.NullOr(Schema.String)),
})
const WorkItemTypeStateListSchema = Schema.Struct({
  value: Schema.Array(WorkItemTypeStateSchema),
})

/** Tail of a build log kept for Investigate (matches GitHub Actions default). */
const DEFAULT_MAX_EXCERPT_CHARS = 12_000

const emptyTerminalChecks: readonly TerminalPrStatusCheck[] = []

const emptyCheckSnapshotFields = {
  mergeability: "unknown" as const,
  baseRefName: null,
  headPushedAt: null,
  headSha: null,
  createdAt: null,
  isDraft: null,
}

const parseInstant = (value: string | null | undefined): Date | null => {
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

type AzureDevOpsCheckOutcome = "green" | "red" | "pending" | "ignore"

const classifyPolicyEvaluationStatus = (
  status: string,
): AzureDevOpsCheckOutcome => {
  const normalized = status.trim().toLowerCase()
  if (normalized === "approved") return "green"
  if (normalized === "rejected" || normalized === "broken") return "red"
  if (normalized === "queued" || normalized === "running") return "pending"
  // notApplicable / unknown: this policy does not gate merge right now.
  return "ignore"
}

const classifyPrStatusState = (state: string): AzureDevOpsCheckOutcome => {
  const normalized = state.trim().toLowerCase()
  if (normalized === "succeeded") return "green"
  if (normalized === "failed" || normalized === "error") return "red"
  if (normalized === "pending") return "pending"
  // notApplicable / unknown.
  return "ignore"
}

const aggregateCheckOutcomes = (
  outcomes: readonly AzureDevOpsCheckOutcome[],
): "pending" | "succeeded" | "failed" | "no_checks" => {
  let hasGreen = false
  let hasRed = false
  let hasPending = false
  for (const outcome of outcomes) {
    if (outcome === "pending") hasPending = true
    else if (outcome === "green") hasGreen = true
    else if (outcome === "red") hasRed = true
  }
  if (hasPending) return "pending"
  if (hasRed) return "failed"
  if (hasGreen) return "succeeded"
  return "no_checks"
}

/**
 * Map Azure DevOps `mergeStatus` to Watch mergeability. Only `conflicts` (an
 * actual git conflict) maps to `conflicting`; policy rejection (`failure`,
 * `rejectedByPolicy`) is a Needs Human / revalidation concern handled via
 * check aggregation, not a Merge Conflict Handoff (mirrors GitLab's posture
 * of not overclaiming a rebase-required conflict from a non-conflict blocker).
 */
const mapAzureDevOpsMergeability = (
  mergeStatus: string | null | undefined,
): PullRequestMergeability => {
  const normalized = (mergeStatus ?? "").trim().toLowerCase()
  if (normalized === "succeeded") return "mergeable"
  if (normalized === "conflicts") return "conflicting"
  return "unknown"
}

const policyEvaluationTerminalChecks = (
  evaluations: readonly AzureDevOpsPolicyEvaluation[],
): readonly TerminalPrStatusCheck[] => {
  const terminals: TerminalPrStatusCheck[] = []
  for (const evaluation of evaluations) {
    const outcome = classifyPolicyEvaluationStatus(evaluation.status)
    if (outcome !== "green" && outcome !== "red") continue
    const displayName = evaluation.configuration?.type?.displayName?.trim()
    terminals.push({
      externalId: `azure-policy:${evaluation.evaluationId}`,
      name:
        displayName !== undefined && displayName !== ""
          ? displayName
          : "Policy",
      outcome,
    })
  }
  return terminals
}

const prStatusTerminalChecks = (
  statuses: readonly AzureDevOpsPrStatus[],
): readonly TerminalPrStatusCheck[] => {
  const terminals: TerminalPrStatusCheck[] = []
  for (const status of statuses) {
    const outcome = classifyPrStatusState(status.state)
    if (outcome !== "green" && outcome !== "red") continue
    const genre = status.context?.genre?.trim() ?? ""
    const name = status.context?.name?.trim() ?? ""
    const label = [genre, name].filter((part) => part !== "").join("/")
    terminals.push({
      externalId: `azure-status:${status.id ?? 0}`,
      name: label !== "" ? label : "Status",
      outcome,
    })
  }
  return terminals
}

const boundLogExcerpt = (logText: string, maxExcerptChars: number): string => {
  if (logText.length <= maxExcerptChars) return logText
  return logText.slice(logText.length - maxExcerptChars)
}

const safeLogFileName = (externalId: string): string =>
  `${externalId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.log`

/** Hidden HTML comment marker tying a completion summary to a Work Item. */
const workItemCompletionMarker = (workItemId: string): string =>
  `<!-- ready-for-agent:work-item:${workItemId} -->`

/** Semaphore for Ready Work Items, mirrors GitHub/GitLab's `ready-for-agent` label. */
const READY_FOR_AGENT_TAG = "ready-for-agent"

/**
 * `System.LinkTypes.Dependency-Reverse` is the "Predecessor" end of a
 * Successor-Predecessor link: the linked work item must complete before this
 * one, i.e. it blocks this one. The forward end
 * (`System.LinkTypes.Dependency-Forward`, "Successor") is the opposite
 * direction and is never surfaced as `blockedBy`.
 */
const PREDECESSOR_LINK_TYPE = "System.LinkTypes.Dependency-Reverse"

/**
 * Work item states treated as closed for Ready Issue / blocking purposes.
 * Azure DevOps has no fixed closed-state name across process templates
 * (Agile: Closed, Scrum: Done/Removed, CMMI: Closed), so this is a
 * heuristic over the common default templates rather than a per-project
 * `workitemtypes/{type}/states` lookup (out of scope for this ticket).
 */
const CLOSED_STATE_NAMES = new Set([
  "closed",
  "done",
  "removed",
  "resolved",
  "completed",
])

const isOpenState = (state: string | undefined): boolean =>
  state === undefined
    ? true
    : !CLOSED_STATE_NAMES.has(state.trim().toLowerCase())

const toIssueState = (state: string | undefined): "OPEN" | "CLOSED" =>
  isOpenState(state) ? "OPEN" : "CLOSED"

const IdentityRefSchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
})

const identityDisplayName = (
  identity: typeof IdentityRefSchema.Type | undefined,
): string | null => {
  if (identity === undefined) return null
  const displayName = identity.displayName?.trim()
  if (displayName !== undefined && displayName !== "") return displayName
  const uniqueName = identity.uniqueName?.trim()
  if (uniqueName !== undefined && uniqueName !== "") return uniqueName
  return null
}

const WorkItemRelationSchema = Schema.Struct({
  rel: RequiredString,
  url: RequiredString,
})

const WorkItemFieldsSchema = Schema.Struct({
  "System.Title": Schema.optional(Schema.String),
  "System.Description": Schema.optional(Schema.NullOr(Schema.String)),
  "System.State": Schema.optional(Schema.String),
  "System.CreatedDate": Schema.optional(Schema.String),
  "System.CreatedBy": Schema.optional(IdentityRefSchema),
})

const WorkItemSchema = Schema.Struct({
  id: Schema.Int,
  fields: WorkItemFieldsSchema,
  relations: Schema.optional(Schema.Array(WorkItemRelationSchema)),
})
type AzureDevOpsWorkItem = typeof WorkItemSchema.Type

const WorkItemBatchSchema = Schema.Struct({
  value: Schema.Array(WorkItemSchema),
})

const WiqlWorkItemRefSchema = Schema.Struct({ id: Schema.Int })
const WiqlResultSchema = Schema.Struct({
  workItems: Schema.optional(Schema.Array(WiqlWorkItemRefSchema)),
})

/** Max work item ids per `_apis/wit/workitems` batch GET (API limit is 200). */
const WORK_ITEM_BATCH_SIZE = 200

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const readyForAgentWiqlQuery = (): string =>
  `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${READY_FOR_AGENT_TAG}' ORDER BY [System.Id]`

const workItemUrl = (
  identity: AzureDevOpsProjectIdentity,
  id: number,
): string =>
  `https://${AZURE_DEVOPS_FORGE_HOST}/${encodeURIComponent(identity.organization)}/${encodeURIComponent(identity.project)}/_workitems/edit/${id}`

/** Extract the numeric work item id from a relation's `.../workItems/{id}` URL. */
const workItemIdFromRelationUrl = (url: string): number | null => {
  const match = /\/workItems\/(\d+)$/i.exec(url)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

const toReadyLabeledIssue = (
  identity: AzureDevOpsProjectIdentity,
  item: AzureDevOpsWorkItem,
  stateById: ReadonlyMap<number, string | undefined>,
): AzureDevOpsReadyLabeledIssue => {
  const fields = item.fields
  const createdAt = new Date(fields["System.CreatedDate"] ?? "")
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `Invalid Azure DevOps work item creation time: ${String(fields["System.CreatedDate"])}`,
    )
  }
  const blockerIds = new Set(
    (item.relations ?? [])
      .filter((relation) => relation.rel === PREDECESSOR_LINK_TYPE)
      .map((relation) => workItemIdFromRelationUrl(relation.url))
      .filter((id): id is number => id !== null),
  )
  const blockedBy = [...blockerIds]
    .filter((id) => isOpenState(stateById.get(id)))
    .sort((left, right) => left - right)
    .map((id) => ({ number: id, url: workItemUrl(identity, id) }))
  return {
    number: item.id,
    title: fields["System.Title"] ?? "",
    body: fields["System.Description"] ?? "",
    url: workItemUrl(identity, item.id),
    createdAt,
    state: toIssueState(fields["System.State"]),
    author: identityDisplayName(fields["System.CreatedBy"]),
    parent: null,
    parentPosition: null,
    hasChildren: false,
    hierarchySupported: false,
    blockedBy,
    closingPullRequests: [],
  } satisfies AzureDevOpsReadyLabeledIssue
}

const decode = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

const organizationApiBase = (organization: string): string =>
  `https://${AZURE_DEVOPS_FORGE_HOST}/${encodeURIComponent(organization)}`

const REFS_HEADS_PREFIX = "refs/heads/"

/** Azure DevOps requires fully-qualified refs on PR create/list bodies. */
const toFullRefName = (branch: string): string =>
  branch.startsWith(REFS_HEADS_PREFIX)
    ? branch
    : `${REFS_HEADS_PREFIX}${branch}`

/** Inverse of {@link toFullRefName}; strips the `refs/heads/` prefix if present. */
const branchFromRefName = (ref: string): string =>
  ref.startsWith(REFS_HEADS_PREFIX) ? ref.slice(REFS_HEADS_PREFIX.length) : ref

/**
 * Azure DevOps Git Pull Requests are scoped by repository, not project. The
 * repositoryId path segment is the Git repository's own name — which is
 * usually, but not always, the same string as the project name (see
 * {@link azureDevOpsRepositoryName}); a project can contain multiple,
 * differently-named Git repositories.
 */
const pullRequestsPath = (
  identity: AzureDevOpsProjectIdentity,
  suffix = "",
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/git/repositories/${encodeURIComponent(azureDevOpsRepositoryName(identity))}/pullrequests${suffix}`

const repositoryMetaPath = (identity: AzureDevOpsProjectIdentity): string =>
  `/${encodeURIComponent(identity.project)}/_apis/git/repositories/${encodeURIComponent(azureDevOpsRepositoryName(identity))}`

const refsPath = (identity: AzureDevOpsProjectIdentity, suffix = ""): string =>
  `/${encodeURIComponent(identity.project)}/_apis/git/repositories/${encodeURIComponent(azureDevOpsRepositoryName(identity))}/refs${suffix}`

const workItemPath = (
  identity: AzureDevOpsProjectIdentity,
  id: number,
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/wit/workitems/${id}`

const workItemCommentsPath = (
  identity: AzureDevOpsProjectIdentity,
  id: number,
): string => `${workItemPath(identity, id)}/comments`

const workItemTypeStatesPath = (
  identity: AzureDevOpsProjectIdentity,
  workItemType: string,
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states`

/**
 * `vstfs:///CodeReview/CodeReviewId/{projectId}/{pullRequestId}`, the artifact
 * id policy evaluations are scoped to. This exact format, and the
 * `repository.project.id` plumbing it depends on (see {@link loadPrChecks}),
 * are unverified against a live Azure DevOps instance — see ADR 0061's
 * "Considered Options" for the known risk and its fail-safe failure mode.
 */
const codeReviewArtifactId = (
  projectId: string,
  pullRequestId: number,
): string => `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`

const policyEvaluationsPath = (
  identity: AzureDevOpsProjectIdentity,
  projectId: string,
  pullRequestId: number,
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(codeReviewArtifactId(projectId, pullRequestId))}`

const policyEvaluationPath = (
  identity: AzureDevOpsProjectIdentity,
  evaluationId: string,
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}`

const prStatusesPath = (
  identity: AzureDevOpsProjectIdentity,
  pullRequestId: number,
): string => pullRequestsPath(identity, `/${pullRequestId}/statuses`)

const buildLogsPath = (
  identity: AzureDevOpsProjectIdentity,
  buildId: number,
): string =>
  `/${encodeURIComponent(identity.project)}/_apis/build/builds/${buildId}/logs`

const buildLogPath = (
  identity: AzureDevOpsProjectIdentity,
  buildId: number,
  logId: number,
): string => `${buildLogsPath(identity, buildId)}/${logId}`

const buildResultsUrl = (
  identity: AzureDevOpsProjectIdentity,
  buildId: number,
): string =>
  `https://${AZURE_DEVOPS_FORGE_HOST}/${encodeURIComponent(identity.organization)}/${encodeURIComponent(identity.project)}/_build/results?buildId=${buildId}`

const requestError = (
  message: string,
  cause: unknown,
): AzureDevOpsRequestError => {
  const code = extractErrorCode(cause)
  return new AzureDevOpsRequestError({
    message,
    cause,
    ...(code !== undefined ? { code } : {}),
    ...(cause instanceof AzureDevOpsHttpError
      ? { statusCode: cause.statusCode }
      : {}),
  })
}

const invalidProjectPath = (
  repository: AzureDevOpsRepository,
): AzureDevOpsRequestError =>
  new AzureDevOpsRequestError({
    message: `Invalid Azure DevOps Project Path (expected <organization>/<project> or <organization>/<project>/<repository>): ${repository.projectPath}`,
  })

const notImplemented = (
  method: string,
): Effect.Effect<never, AzureDevOpsNotImplementedError> =>
  Effect.fail(new AzureDevOpsNotImplementedError({ method }))

export const makeAzureDevOpsService = (options: {
  readonly token?: string
  readonly fetch?: AzureDevOpsFetch
}): AzureDevOpsServiceShape => {
  const fetchImpl = options.fetch ?? fetch
  const headers: Record<string, string> =
    options.token === undefined || options.token.trim() === ""
      ? { Accept: "application/json" }
      : {
          Accept: "application/json",
          // Azure DevOps PAT auth: HTTP Basic with an empty username.
          Authorization: `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`,
        }

  const requestUnknown = (
    organization: string,
    path: string,
    message: string,
    init: {
      readonly method?: string
      readonly body?: unknown
      /** Overrides the default `application/json` request Content-Type. */
      readonly contentType?: string
      /** Overrides {@link API_VERSION}, e.g. for preview-only endpoints. */
      readonly apiVersion?: string
    } = {},
  ): Effect.Effect<unknown, AzureDevOpsRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const separator = path.includes("?") ? "&" : "?"
        const response = await fetchImpl(
          `${organizationApiBase(organization)}${path}${separator}api-version=${init.apiVersion ?? API_VERSION}`,
          {
            method: init.method ?? "GET",
            headers: {
              ...headers,
              ...(init.body === undefined
                ? {}
                : { "Content-Type": init.contentType ?? "application/json" }),
            },
            body:
              init.body === undefined ? undefined : JSON.stringify(init.body),
          },
        )
        if (!response.ok) {
          throw new AzureDevOpsHttpError(
            response.status,
            `${message}: Azure DevOps returned HTTP ${response.status}`,
          )
        }
        return await response.json()
      },
      catch: (cause) => requestError(message, cause),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(requestError(`${message} timed out`, cause)),
      ),
    )

  /** Plain-text response body (build log content). */
  const requestText = (
    organization: string,
    path: string,
    message: string,
  ): Effect.Effect<string, AzureDevOpsRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const separator = path.includes("?") ? "&" : "?"
        const response = await fetchImpl(
          `${organizationApiBase(organization)}${path}${separator}api-version=${API_VERSION}`,
          { method: "GET", headers },
        )
        if (!response.ok) {
          throw new AzureDevOpsHttpError(
            response.status,
            `${message}: Azure DevOps returned HTTP ${response.status}`,
          )
        }
        return await response.text()
      },
      catch: (cause) => requestError(message, cause),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(requestError(`${message} timed out`, cause)),
      ),
    )

  /**
   * Batch-fetch work items with all fields and relations
   * (`$expand=all`) for the given ids, chunked to the API's per-request
   * limit. `errorPolicy=Omit` so a deleted/inaccessible id (e.g. a stale
   * Predecessor link target) drops that item instead of failing the whole
   * batch.
   */
  const fetchWorkItemsWithRelations = (
    organization: string,
    ids: readonly number[],
  ): Effect.Effect<readonly AzureDevOpsWorkItem[], AzureDevOpsRequestError> =>
    Effect.gen(function* () {
      const results: AzureDevOpsWorkItem[] = []
      for (const batch of chunk(ids, WORK_ITEM_BATCH_SIZE)) {
        const value = yield* requestUnknown(
          organization,
          `/_apis/wit/workitems?ids=${batch.join(",")}&$expand=all&errorPolicy=Omit`,
          `Failed to load Azure DevOps work items ${batch.join(",")}`,
        )
        const decoded = yield* Effect.try({
          try: () => decode(WorkItemBatchSchema, value),
          catch: (cause) =>
            requestError("Azure DevOps returned invalid work item data", cause),
        })
        results.push(...decoded.value)
      }
      return results
    })

  const unavailableOn404 = <A>(
    repository: AzureDevOpsRepository,
    effect: Effect.Effect<A, AzureDevOpsRequestError>,
  ): Effect.Effect<
    A,
    AzureDevOpsProjectUnavailableError | AzureDevOpsRequestError
  > =>
    effect.pipe(
      Effect.catch(
        (
          error,
        ): Effect.Effect<
          never,
          AzureDevOpsProjectUnavailableError | AzureDevOpsRequestError
        > =>
          error.statusCode === 404
            ? Effect.fail(new AzureDevOpsProjectUnavailableError(repository))
            : Effect.fail(error),
      ),
    )

  const decodePullRequest = (
    value: unknown,
    message: string,
  ): Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsRequestError> =>
    Effect.try({
      try: () => decode(PullRequestSchema, value),
      catch: (cause) => requestError(message, cause),
    })

  /**
   * Active pull requests for the exact source branch, newest first per
   * Azure DevOps default ordering. Empty when none exist (does not fail).
   */
  const listPullRequestsForBranch = (
    repository: AzureDevOpsRepository,
    identity: AzureDevOpsProjectIdentity,
    headRefName: string,
  ): Effect.Effect<
    readonly AzureDevOpsPullRequest[],
    AzureDevOpsServiceError
  > =>
    unavailableOn404(
      repository,
      requestUnknown(
        identity.organization,
        `${pullRequestsPath(identity)}?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(toFullRefName(headRefName))}`,
        `Failed to list pull requests for ${repository.projectPath}:${headRefName}`,
      ).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => decode(PullRequestListSchema, value).value,
            catch: (cause) =>
              requestError(
                `Azure DevOps returned invalid pull request data for ${repository.projectPath}:${headRefName}`,
                cause,
              ),
          }),
        ),
      ),
    )

  /**
   * List pull requests for the exact source branch scoped by
   * `searchCriteria.status`. Empty when none exist (does not fail).
   */
  const listPullRequestsForBranchByStatus = (
    repository: AzureDevOpsRepository,
    identity: AzureDevOpsProjectIdentity,
    headRefName: string,
    status: "active" | "all",
  ): Effect.Effect<
    readonly AzureDevOpsPullRequest[],
    AzureDevOpsServiceError
  > =>
    unavailableOn404(
      repository,
      requestUnknown(
        identity.organization,
        `${pullRequestsPath(identity)}?searchCriteria.status=${status}&searchCriteria.sourceRefName=${encodeURIComponent(toFullRefName(headRefName))}`,
        `Failed to list pull requests for ${repository.projectPath}:${headRefName}`,
      ).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => decode(PullRequestListSchema, value).value,
            catch: (cause) =>
              requestError(
                `Azure DevOps returned invalid pull request data for ${repository.projectPath}:${headRefName}`,
                cause,
              ),
          }),
        ),
      ),
    )

  /**
   * Prefer an active pull request for the branch; if none, the latest
   * any-state pull request (completed/abandoned) so lifecycle callers can
   * observe terminal outcomes. Mirrors GitLab's
   * `resolveMergeRequestIidForBranch`.
   */
  const resolvePullRequestForBranch = (
    repository: AzureDevOpsRepository,
    identity: AzureDevOpsProjectIdentity,
    headRefName: string,
  ): Effect.Effect<AzureDevOpsPullRequest | null, AzureDevOpsServiceError> =>
    Effect.gen(function* () {
      const active = yield* listPullRequestsForBranchByStatus(
        repository,
        identity,
        headRefName,
        "active",
      )
      if (active[0] !== undefined) return active[0]
      const all = yield* listPullRequestsForBranchByStatus(
        repository,
        identity,
        headRefName,
        "all",
      )
      return all[0] ?? null
    })

  /**
   * Best-effort head-commit push time via the commit resource's committer
   * (falling back to author) date. Any lookup failure leaves null so
   * Check-Start Deadline can use the observation fallback (matches GitLab).
   */
  const loadHeadPushedAt = (
    identity: AzureDevOpsProjectIdentity,
    headSha: string | null,
  ): Effect.Effect<Date | null, never> =>
    Effect.gen(function* () {
      if (headSha === null || headSha.trim() === "") return null
      const result = yield* requestUnknown(
        identity.organization,
        `/${encodeURIComponent(identity.project)}/_apis/git/repositories/${encodeURIComponent(azureDevOpsRepositoryName(identity))}/commits/${encodeURIComponent(headSha)}`,
        `Failed to load head commit ${headSha}`,
      ).pipe(Effect.result)
      if (Result.isFailure(result)) return null
      const commit = yield* Effect.try({
        try: () => decode(CommitMetaSchema, result.success),
        catch: () => null as null,
      }).pipe(Effect.orElseSucceed(() => null))
      if (commit === null) return null
      return (
        parseInstant(commit.committer?.date) ??
        parseInstant(commit.author?.date)
      )
    })

  /**
   * Load branch policy evaluations (including build validation) and pull
   * request statuses for a pull request, and reduce them to the same
   * terminal-check + aggregate shape Watch/Merge already expect from
   * GitHub/GitLab. A 404 on either endpoint is treated as an empty list (the
   * pull request itself already loaded successfully).
   */
  const loadPrChecks = (
    repository: AzureDevOpsRepository,
    identity: AzureDevOpsProjectIdentity,
    pr: AzureDevOpsPullRequest,
  ): Effect.Effect<
    {
      readonly terminalChecks: readonly TerminalPrStatusCheck[]
      readonly aggregate: "pending" | "succeeded" | "failed" | "no_checks"
    },
    AzureDevOpsServiceError
  > =>
    Effect.gen(function* () {
      const projectId = pr.repository?.project?.id?.trim() ?? ""
      const evaluations: readonly AzureDevOpsPolicyEvaluation[] =
        projectId === ""
          ? []
          : yield* requestUnknown(
              identity.organization,
              policyEvaluationsPath(identity, projectId, pr.pullRequestId),
              `Failed to load policy evaluations for pull request ${pr.pullRequestId} on ${repository.projectPath}`,
              { apiVersion: POLICY_EVALUATIONS_API_VERSION },
            ).pipe(
              Effect.flatMap((value) =>
                Effect.try({
                  try: () => decode(PolicyEvaluationListSchema, value).value,
                  catch: (cause) =>
                    requestError(
                      `Azure DevOps returned invalid policy evaluations for ${repository.projectPath}`,
                      cause,
                    ),
                }),
              ),
              Effect.catch((error) =>
                error instanceof AzureDevOpsRequestError &&
                error.statusCode === 404
                  ? Effect.succeed([] as readonly AzureDevOpsPolicyEvaluation[])
                  : Effect.fail(error),
              ),
            )
      const statuses = yield* requestUnknown(
        identity.organization,
        prStatusesPath(identity, pr.pullRequestId),
        `Failed to load pull request statuses for pull request ${pr.pullRequestId} on ${repository.projectPath}`,
      ).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => decode(PrStatusListSchema, value).value,
            catch: (cause) =>
              requestError(
                `Azure DevOps returned invalid pull request statuses for ${repository.projectPath}`,
                cause,
              ),
          }),
        ),
        Effect.catch((error) =>
          error instanceof AzureDevOpsRequestError && error.statusCode === 404
            ? Effect.succeed([] as readonly AzureDevOpsPrStatus[])
            : Effect.fail(error),
        ),
      )
      const terminalChecks = [
        ...policyEvaluationTerminalChecks(evaluations),
        ...prStatusTerminalChecks(statuses),
      ].sort((left, right) => left.externalId.localeCompare(right.externalId))
      const aggregate = aggregateCheckOutcomes([
        ...evaluations.map((evaluation) =>
          classifyPolicyEvaluationStatus(evaluation.status),
        ),
        ...statuses.map((status) => classifyPrStatusState(status.state)),
      ])
      return { terminalChecks, aggregate }
    })

  /**
   * Resolve the base branch for a new draft pull request: an explicit
   * `baseRefName` when provided, otherwise the Git repository's default
   * branch (Azure DevOps project metadata has no default-branch field —
   * that lives on the repository resource, unlike GitLab's project).
   */
  const resolveBaseRefName = (
    repository: AzureDevOpsRepository,
    identity: AzureDevOpsProjectIdentity,
    explicitBaseRefName: string | undefined,
  ): Effect.Effect<string, AzureDevOpsServiceError> =>
    Effect.gen(function* () {
      const trimmed = explicitBaseRefName?.trim() ?? ""
      if (trimmed !== "") return trimmed
      const meta = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          repositoryMetaPath(identity),
          `Failed to resolve the default branch for ${repository.projectPath}`,
        ).pipe(
          Effect.map((value) => decode(RepositoryMetaSchema, value)),
          Effect.mapError((error) =>
            error instanceof AzureDevOpsRequestError
              ? error
              : requestError(
                  `Azure DevOps returned invalid repository metadata for ${repository.projectPath}`,
                  error,
                ),
          ),
        ),
      )
      const defaultBranch = meta.defaultBranch?.trim() ?? ""
      if (defaultBranch === "") {
        return yield* new AzureDevOpsRequestError({
          message: `Repository ${repository.projectPath} has no default base branch`,
        })
      }
      return branchFromRefName(defaultBranch)
    })

  return {
    verifyProject: Effect.fn("AzureDevOpsService.verifyProject")(
      function* (repository) {
        const identity = splitAzureDevOpsProjectPath(repository.projectPath)
        if (identity === null) {
          return yield* invalidProjectPath(repository)
        }
        const value = yield* unavailableOn404(
          repository,
          requestUnknown(
            identity.organization,
            `/_apis/projects/${encodeURIComponent(identity.project)}`,
            `Failed to verify Azure DevOps project ${repository.projectPath}`,
          ),
        )
        const project = yield* Effect.try({
          try: () => decode(ProjectSchema, value),
          catch: (cause) =>
            requestError("Azure DevOps returned an invalid project", cause),
        })
        // Project verification only canonicalizes the org/project segments
        // (e.g. case correction); an explicit repository segment (present
        // when the Git repository name differs from the project name) is
        // carried through unchanged — this method is intentionally
        // project-scoped only and never validates the Git repository name.
        const projectPath =
          identity.repository === undefined
            ? `${identity.organization}/${project.name}`
            : `${identity.organization}/${project.name}/${identity.repository}`
        return {
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath,
        } satisfies AzureDevOpsRepository
      },
    ),
    getAuthenticatedUserLogin: Effect.fn(
      "AzureDevOpsService.getAuthenticatedUserLogin",
    )(function* (repository) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const value = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          "/_apis/connectionData",
          `Failed to resolve authenticated Azure DevOps user for ${identity.organization}`,
          { apiVersion: CONNECTION_DATA_API_VERSION },
        ),
      )
      const connectionData = yield* Effect.try({
        try: () => decode(ConnectionDataSchema, value),
        catch: (cause) =>
          requestError("Azure DevOps returned invalid connection data", cause),
      })
      // Prefer customDisplayName: it matches System.CreatedBy.displayName on
      // work items authored by this account. providerDisplayName is the
      // Entra/AAD directory name, which can read differently for the same
      // account (e.g. "Christopher Barlow" vs work items' "Chris Barlow"),
      // silently breaking author-scoped relevance matching if preferred.
      const customDisplayName =
        connectionData.authenticatedUser.customDisplayName
      if (
        typeof customDisplayName === "string" &&
        customDisplayName.trim() !== ""
      ) {
        return customDisplayName
      }
      const providerDisplayName =
        connectionData.authenticatedUser.providerDisplayName
      if (
        typeof providerDisplayName === "string" &&
        providerDisplayName.trim() !== ""
      ) {
        return providerDisplayName
      }
      const id = connectionData.authenticatedUser.id
      if (typeof id === "string" && id.trim() !== "") {
        return id
      }
      return yield* requestError(
        "Azure DevOps did not return an authenticated user identity",
        connectionData,
      )
    }),
    listReadyIssues: Effect.fn("AzureDevOpsService.listReadyIssues")(
      function* (repository) {
        const identity = splitAzureDevOpsProjectPath(repository.projectPath)
        if (identity === null) {
          return yield* invalidProjectPath(repository)
        }
        const wiqlValue = yield* unavailableOn404(
          repository,
          requestUnknown(
            identity.organization,
            `/${encodeURIComponent(identity.project)}/_apis/wit/wiql`,
            `Failed to list Ready Issues for ${repository.projectPath}`,
            { method: "POST", body: { query: readyForAgentWiqlQuery() } },
          ),
        )
        const wiql = yield* Effect.try({
          try: () => decode(WiqlResultSchema, wiqlValue),
          catch: (cause) =>
            requestError("Azure DevOps returned an invalid WIQL result", cause),
        })
        const ids = (wiql.workItems ?? []).map((item) => item.id)
        if (ids.length === 0) return []

        const items = yield* unavailableOn404(
          repository,
          fetchWorkItemsWithRelations(identity.organization, ids),
        )
        const knownIds = new Set(items.map((item) => item.id))
        const blockerIds = new Set<number>()
        for (const item of items) {
          for (const relation of item.relations ?? []) {
            if (relation.rel !== PREDECESSOR_LINK_TYPE) continue
            const blockerId = workItemIdFromRelationUrl(relation.url)
            if (blockerId !== null) blockerIds.add(blockerId)
          }
        }
        const missingBlockerIds = [...blockerIds].filter(
          (id) => !knownIds.has(id),
        )
        const blockerItems =
          missingBlockerIds.length === 0
            ? []
            : yield* unavailableOn404(
                repository,
                fetchWorkItemsWithRelations(
                  identity.organization,
                  missingBlockerIds,
                ),
              )
        const stateById = new Map<number, string | undefined>()
        for (const item of [...items, ...blockerItems]) {
          stateById.set(item.id, item.fields["System.State"])
        }

        return yield* Effect.try({
          try: () =>
            items
              .filter((item) => isOpenState(item.fields["System.State"]))
              .map((item) => toReadyLabeledIssue(identity, item, stateById))
              .sort((left, right) => left.number - right.number),
          catch: (cause) =>
            requestError("Azure DevOps returned invalid work item data", cause),
        })
      },
    ),
    hasCredentials: () => Effect.succeed(options.token !== undefined),
    hasAmbientCredentials: () => Effect.succeed(options.token !== undefined),
    getOpenPullRequestNumber: Effect.fn(
      "AzureDevOpsService.getOpenPullRequestNumber",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const list = yield* listPullRequestsForBranch(
        repository,
        identity,
        headRefName,
      )
      const first = list[0]
      if (first === undefined) {
        return yield* new AzureDevOpsRequestError({
          message: `No open pull request found for ${repository.projectPath}:${headRefName}`,
        })
      }
      return first.pullRequestId
    }),
    findOpenPullRequestNumber: Effect.fn(
      "AzureDevOpsService.findOpenPullRequestNumber",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const list = yield* listPullRequestsForBranch(
        repository,
        identity,
        headRefName,
      )
      const first = list[0]
      return first === undefined ? null : first.pullRequestId
    }),
    createDraftPullRequest: Effect.fn(
      "AzureDevOpsService.createDraftPullRequest",
    )(function* (repository, input) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const baseRefName = yield* resolveBaseRefName(
        repository,
        identity,
        input.baseRefName,
      )
      const created = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          pullRequestsPath(identity),
          `Failed to create draft pull request for ${repository.projectPath}:${input.headRefName}`,
          {
            method: "POST",
            body: {
              sourceRefName: toFullRefName(input.headRefName),
              targetRefName: toFullRefName(baseRefName),
              title: input.title,
              description: input.body,
              isDraft: true,
            },
          },
        ).pipe(
          Effect.flatMap((value) =>
            decodePullRequest(
              value,
              `Azure DevOps returned an invalid pull request after create for ${repository.projectPath}:${input.headRefName}`,
            ),
          ),
        ),
      )
      if (created.isDraft !== true) {
        return yield* new AzureDevOpsRequestError({
          message: `Azure DevOps did not create a draft pull request for ${repository.projectPath}:${input.headRefName}`,
        })
      }
      return created.pullRequestId
    }),
    updateOpenDraftPullRequestCopy: Effect.fn(
      "AzureDevOpsService.updateOpenDraftPullRequestCopy",
    )(function* (repository, headRefName, input) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const list = yield* listPullRequestsForBranch(
        repository,
        identity,
        headRefName,
      )
      const details = list[0]
      if (details === undefined) {
        return null
      }
      // Non-draft open PRs (ready for review / human-edited): do not overwrite.
      if (details.isDraft !== true) {
        return details.pullRequestId
      }
      const currentTitle = details.title ?? ""
      const currentBody = details.description ?? ""
      if (currentTitle === input.title && currentBody === input.body) {
        return details.pullRequestId
      }
      // Copy update is best-effort: open draft identity remains valid.
      yield* requestUnknown(
        identity.organization,
        pullRequestsPath(identity, `/${details.pullRequestId}`),
        `Failed to update draft pull request ${details.pullRequestId} for ${repository.projectPath}`,
        {
          method: "PATCH",
          body: { title: input.title, description: input.body },
        },
      ).pipe(Effect.asVoid, Effect.ignore)
      return details.pullRequestId
    }),
    countOpenNonDraftPullRequests: () =>
      notImplemented("countOpenNonDraftPullRequests"),
    getPullRequestCheckStatus: Effect.fn(
      "AzureDevOpsService.getPullRequestCheckStatus",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const pr = yield* resolvePullRequestForBranch(
        repository,
        identity,
        headRefName,
      )
      // Not-yet-visible PR after Create PR: same pending empty snapshot as
      // GitHub/GitLab.
      if (pr === null) {
        return {
          _tag: "pending",
          terminalChecks: emptyTerminalChecks,
          ...emptyCheckSnapshotFields,
        } satisfies PullRequestCheckStatus
      }
      const headSha = pr.lastMergeSourceCommit?.commitId?.trim() || null
      const targetRefName = pr.targetRefName?.trim() ?? ""
      const baseRefName =
        targetRefName === "" ? null : branchFromRefName(targetRefName)
      const createdAt = parseInstant(pr.creationDate)
      const isDraft = pr.isDraft ?? null
      const headPushedAt = yield* loadHeadPushedAt(identity, headSha)
      const snapshot = {
        mergeability: mapAzureDevOpsMergeability(pr.mergeStatus),
        baseRefName,
        headPushedAt,
        headSha,
        createdAt,
        isDraft,
      } as const

      if (pr.status === "completed") {
        // Merged PRs settle Watch onto the cleanup path regardless of any
        // stale check/mergeability reported after completion (matches
        // GitHub/GitLab forcing mergeable on merged).
        return {
          _tag: "succeeded",
          terminalChecks: emptyTerminalChecks,
          ...snapshot,
          mergeability: "mergeable",
        } satisfies PullRequestCheckStatus
      }
      if (pr.status === "abandoned") {
        return { _tag: "closed", ...snapshot } satisfies PullRequestCheckStatus
      }

      const { terminalChecks, aggregate } = yield* loadPrChecks(
        repository,
        identity,
        pr,
      )
      if (aggregate === "pending") {
        return {
          _tag: "pending",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      if (aggregate === "failed") {
        return {
          _tag: "failed",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      if (aggregate === "succeeded") {
        return {
          _tag: "succeeded",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      return { _tag: "no_checks", ...snapshot } satisfies PullRequestCheckStatus
    }),
    getPrStatusCheckDiagnostics: Effect.fn(
      "AzureDevOpsService.getPrStatusCheckDiagnostics",
    )(function* (repository, checks, options = {}) {
      if (checks.length === 0) {
        return []
      }
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const maxExcerptChars =
        typeof options.maxExcerptChars === "number" &&
        Number.isSafeInteger(options.maxExcerptChars) &&
        options.maxExcerptChars > 0
          ? options.maxExcerptChars
          : DEFAULT_MAX_EXCERPT_CHARS
      const logDirectory =
        typeof options.logDirectory === "string" &&
        options.logDirectory.trim() !== ""
          ? options.logDirectory
          : undefined
      if (logDirectory !== undefined) {
        yield* Effect.tryPromise({
          try: () => mkdir(logDirectory, { recursive: true }),
          catch: (cause) =>
            requestError(
              `Failed to create PR Status Check diagnostic log directory for ${repository.projectPath}`,
              cause,
            ),
        })
      }

      const diagnostics: PrStatusCheckDiagnostic[] = []
      for (const check of checks) {
        if (check.externalId.startsWith("azure-policy:")) {
          const evaluationId = check.externalId.slice("azure-policy:".length)
          const evaluationResult = yield* requestUnknown(
            identity.organization,
            policyEvaluationPath(identity, evaluationId),
            `Failed to load policy evaluation ${evaluationId} for ${repository.projectPath}`,
            { apiVersion: POLICY_EVALUATIONS_API_VERSION },
          ).pipe(Effect.result)
          if (Result.isFailure(evaluationResult)) {
            diagnostics.push({
              externalId: check.externalId,
              name: check.name,
              source: "azure-policy",
              htmlUrl: null,
              logFetch: {
                _tag: "unavailable",
                reason: evaluationResult.failure.message,
              },
            })
            continue
          }
          const evaluation = yield* Effect.try({
            try: () => decode(PolicyEvaluationSchema, evaluationResult.success),
            catch: () => null as null,
          }).pipe(Effect.orElseSucceed(() => null))
          const buildId = evaluation?.context?.buildId ?? null
          if (buildId === null) {
            diagnostics.push({
              externalId: check.externalId,
              name: check.name,
              source: "azure-policy",
              htmlUrl: null,
              logFetch: {
                _tag: "unavailable",
                reason: "No build is associated with this policy evaluation",
              },
            })
            continue
          }
          const htmlUrl = buildResultsUrl(identity, buildId)
          const logsResult = yield* requestUnknown(
            identity.organization,
            buildLogsPath(identity, buildId),
            `Failed to list build logs for build ${buildId} on ${repository.projectPath}`,
          ).pipe(Effect.result)
          if (Result.isFailure(logsResult)) {
            diagnostics.push({
              externalId: check.externalId,
              name: check.name,
              source: "azure-policy",
              htmlUrl,
              logFetch: {
                _tag: "unavailable",
                reason: logsResult.failure.message,
              },
            })
            continue
          }
          const logs = yield* Effect.try({
            try: () => decode(BuildLogListSchema, logsResult.success).value,
            catch: (cause) =>
              requestError(
                `Azure DevOps returned invalid build logs for build ${buildId}`,
                cause,
              ),
          })
          const lastLog = logs.at(-1)
          if (lastLog === undefined) {
            diagnostics.push({
              externalId: check.externalId,
              name: check.name,
              source: "azure-policy",
              htmlUrl,
              logFetch: {
                _tag: "unavailable",
                reason: `Build ${buildId} has no logs`,
              },
            })
            continue
          }
          const logTextResult = yield* requestText(
            identity.organization,
            buildLogPath(identity, buildId, lastLog.id),
            `Failed to load build log ${lastLog.id} for build ${buildId} on ${repository.projectPath}`,
          ).pipe(Effect.result)
          if (Result.isFailure(logTextResult)) {
            diagnostics.push({
              externalId: check.externalId,
              name: check.name,
              source: "azure-policy",
              htmlUrl,
              logFetch: {
                _tag: "unavailable",
                reason: logTextResult.failure.message,
              },
            })
            continue
          }
          const logText = logTextResult.success
          let localPath: string | null = null
          if (logDirectory !== undefined) {
            const path = join(logDirectory, safeLogFileName(check.externalId))
            yield* Effect.tryPromise({
              try: () => writeFile(path, logText, "utf8"),
              catch: (cause) =>
                requestError(
                  `Failed to write PR Status Check diagnostic log for ${check.externalId}`,
                  cause,
                ),
            })
            localPath = path
          }
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source: "azure-policy",
            htmlUrl,
            logFetch: {
              _tag: "ok",
              excerpt: boundLogExcerpt(logText, maxExcerptChars),
              localPath,
            },
          })
          continue
        }
        if (check.externalId.startsWith("azure-status:")) {
          // Azure DevOps generic PR statuses carry no log content via REST.
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source: "azure-status",
            htmlUrl: null,
            logFetch: {
              _tag: "unavailable",
              reason:
                "Azure DevOps does not expose log content for pull request statuses",
            },
          })
          continue
        }
        diagnostics.push({
          externalId: check.externalId,
          name: check.name,
          source: "unknown",
          htmlUrl: null,
          logFetch: {
            _tag: "unavailable",
            reason: `No Azure DevOps source recognized for external id ${check.externalId}`,
          },
        })
      }
      return diagnostics
    }),
    markPullRequestReadyForReview: Effect.fn(
      "AzureDevOpsService.markPullRequestReadyForReview",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const list = yield* listPullRequestsForBranch(
        repository,
        identity,
        headRefName,
      )
      const listed = list[0]
      if (listed === undefined) {
        return yield* new AzureDevOpsRequestError({
          message: `No open pull request found for ${repository.projectPath}:${headRefName}`,
        })
      }
      // Already ready for review: idempotent success.
      if (listed.isDraft !== true) {
        return
      }
      const updated = yield* requestUnknown(
        identity.organization,
        pullRequestsPath(identity, `/${listed.pullRequestId}`),
        `Failed to mark pull request ${listed.pullRequestId} ready for review for ${repository.projectPath}`,
        {
          method: "PATCH",
          body: { isDraft: false },
        },
      ).pipe(
        Effect.flatMap((value) =>
          decodePullRequest(
            value,
            `Azure DevOps returned an invalid pull request after mark ready for ${repository.projectPath}:${headRefName}`,
          ),
        ),
      )
      if (updated.isDraft === true) {
        return yield* new AzureDevOpsRequestError({
          message: `Azure DevOps did not clear the draft flag for pull request ${listed.pullRequestId} for ${repository.projectPath}:${headRefName}`,
        })
      }
    }),
    getPullRequestLifecycleStatus: Effect.fn(
      "AzureDevOpsService.getPullRequestLifecycleStatus",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const pr = yield* resolvePullRequestForBranch(
        repository,
        identity,
        headRefName,
      )
      if (pr === null) {
        return { _tag: "not_found" } satisfies PullRequestLifecycleStatus
      }
      if (pr.status === "completed") {
        return { _tag: "merged" } satisfies PullRequestLifecycleStatus
      }
      if (pr.status === "abandoned") {
        return { _tag: "closed" } satisfies PullRequestLifecycleStatus
      }
      if (pr.status === "active" || pr.status === undefined) {
        return { _tag: "open" } satisfies PullRequestLifecycleStatus
      }
      return yield* new AzureDevOpsRequestError({
        message: `Azure DevOps returned an invalid pull request status for ${repository.projectPath}:${headRefName}`,
      })
    }),
    mergePullRequest: Effect.fn("AzureDevOpsService.mergePullRequest")(
      function* (repository, headRefName, options) {
        const identity = splitAzureDevOpsProjectPath(repository.projectPath)
        if (identity === null) {
          return yield* invalidProjectPath(repository)
        }

        /**
         * Job-level check rollup for merge pre-checks. An absent/no_checks
         * aggregate (including all-notApplicable policies) is not green
         * unless `acceptNoChecks` is set (matches GitLab's `always` policy).
         */
        const checksBlockingReason = (
          pr: AzureDevOpsPullRequest,
        ): Effect.Effect<
          "checks_not_green" | "missing_successful_checks" | null,
          AzureDevOpsServiceError
        > =>
          Effect.gen(function* () {
            const { aggregate } = yield* loadPrChecks(repository, identity, pr)
            if (aggregate === "pending" || aggregate === "failed") {
              return "checks_not_green" as const
            }
            if (aggregate === "no_checks") {
              return options?.acceptNoChecks === true
                ? null
                : ("missing_successful_checks" as const)
            }
            return null
          })

        const classifyOpenPullRequest = (
          pr: AzureDevOpsPullRequest,
        ): Effect.Effect<
          | MergePullRequestResult
          | { readonly _tag: "ready"; readonly sha: string },
          AzureDevOpsServiceError
        > =>
          Effect.gen(function* () {
            if (pr.status === "completed") {
              return { _tag: "merged" } as const
            }
            if (pr.status === "abandoned") {
              return {
                _tag: "needs_human" as const,
                reason: "closed_unmerged" as const,
                message: `Pull request for ${repository.projectPath}:${headRefName} was closed without merging`,
              }
            }
            if (pr.status !== "active" && pr.status !== undefined) {
              return yield* new AzureDevOpsRequestError({
                message: `Azure DevOps returned an invalid pull request status for ${repository.projectPath}:${headRefName}`,
              })
            }
            if (pr.isDraft === true) {
              return {
                _tag: "revalidation" as const,
                reason: "mergeability_changed" as const,
                message: `Pull request is still a draft for ${repository.projectPath}:${headRefName}`,
              }
            }
            const headSha = pr.lastMergeSourceCommit?.commitId?.trim() || null
            if (headSha === null) {
              return yield* new AzureDevOpsRequestError({
                message: `Azure DevOps returned an invalid pull request head for ${repository.projectPath}:${headRefName}`,
              })
            }
            const blockingReason = yield* checksBlockingReason(pr)
            if (blockingReason === "missing_successful_checks") {
              return {
                _tag: "needs_human" as const,
                reason: "missing_successful_checks" as const,
                message: `No successful build validation / branch policy checks were reported for ${repository.projectPath}:${headRefName}`,
              }
            }
            if (blockingReason === "checks_not_green") {
              return {
                _tag: "revalidation" as const,
                reason: "checks_not_green" as const,
                message: `Pull request checks are no longer successful for ${repository.projectPath}:${headRefName}`,
              }
            }
            const mergeability = mapAzureDevOpsMergeability(pr.mergeStatus)
            if (mergeability !== "mergeable") {
              return {
                _tag: "revalidation" as const,
                reason: "mergeability_changed" as const,
                message: `Pull request mergeability is ${mergeability} for ${repository.projectPath}:${headRefName}`,
              }
            }
            return { _tag: "ready" as const, sha: headSha }
          })

        const initial = yield* resolvePullRequestForBranch(
          repository,
          identity,
          headRefName,
        )
        if (initial === null) {
          return yield* new AzureDevOpsRequestError({
            message: `No pull request found for ${repository.projectPath}:${headRefName}`,
          })
        }
        const prepared = yield* classifyOpenPullRequest(initial)
        if (prepared._tag !== "ready") {
          return prepared
        }
        const expectedHeadSha = prepared.sha

        const mergeResult = yield* requestUnknown(
          identity.organization,
          pullRequestsPath(identity, `/${initial.pullRequestId}`),
          `Failed to merge pull request ${initial.pullRequestId} for ${repository.projectPath}`,
          {
            method: "PATCH",
            body: {
              status: "completed",
              lastMergeSourceCommit: { commitId: expectedHeadSha },
              completionOptions: { transitionWorkItems: true },
            },
          },
        ).pipe(
          Effect.flatMap((value) =>
            decodePullRequest(
              value,
              `Azure DevOps returned an invalid pull request after merge for ${repository.projectPath}:${headRefName}`,
            ),
          ),
          Effect.result,
        )

        if (Result.isSuccess(mergeResult)) {
          const merged = mergeResult.success
          if (merged.status === "completed") {
            return { _tag: "merged" } as const
          }
          if (merged.status === "abandoned") {
            return {
              _tag: "needs_human" as const,
              reason: "closed_unmerged" as const,
              message: `Pull request for ${repository.projectPath}:${headRefName} was concurrently closed without merging`,
            }
          }
          // Unexpected non-completed success body (e.g. still active after a
          // rejected merge attempt): re-fetch and classify below.
        } else {
          const failure = mergeResult.failure
          // Operational failures (auth, missing project, transport, 5xx)
          // always propagate. Azure DevOps reports merge preconditions that
          // changed concurrently (stale head, still-pending/unsatisfied
          // policy) as 400, 409, or 422; those are re-classified from a
          // fresh pull request instead.
          if (
            failure.statusCode !== 400 &&
            failure.statusCode !== 409 &&
            failure.statusCode !== 422
          ) {
            return yield* failure
          }
        }

        const refreshed = yield* resolvePullRequestForBranch(
          repository,
          identity,
          headRefName,
        )
        if (refreshed === null) {
          return yield* new AzureDevOpsRequestError({
            message: `Azure DevOps did not return a pull request after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        if (refreshed.status === "completed") {
          return { _tag: "merged" } as const
        }
        if (refreshed.status === "abandoned") {
          return {
            _tag: "needs_human" as const,
            reason: "closed_unmerged" as const,
            message: `Pull request for ${repository.projectPath}:${headRefName} was concurrently closed without merging`,
          }
        }
        if (refreshed.status !== "active" && refreshed.status !== undefined) {
          return yield* new AzureDevOpsRequestError({
            message: `Azure DevOps returned an invalid pull request status after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        if (refreshed.isDraft === true) {
          return {
            _tag: "revalidation" as const,
            reason: "mergeability_changed" as const,
            message: `Pull request is still a draft for ${repository.projectPath}:${headRefName}`,
          }
        }
        const refreshedSha =
          refreshed.lastMergeSourceCommit?.commitId?.trim() || null
        if (refreshedSha === null) {
          return yield* new AzureDevOpsRequestError({
            message: `Azure DevOps returned an invalid pull request head after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        if (refreshedSha !== expectedHeadSha) {
          return {
            _tag: "revalidation" as const,
            reason: "head_changed" as const,
            message: `Pull request head changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        const blockingReason = yield* checksBlockingReason(refreshed)
        if (blockingReason === "missing_successful_checks") {
          return {
            _tag: "needs_human" as const,
            reason: "missing_successful_checks" as const,
            message: `No successful build validation / branch policy checks were reported while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        if (blockingReason === "checks_not_green") {
          return {
            _tag: "revalidation" as const,
            reason: "checks_not_green" as const,
            message: `Pull request checks changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        const mergeability = mapAzureDevOpsMergeability(refreshed.mergeStatus)
        if (mergeability === "conflicting" || mergeability === "unknown") {
          return {
            _tag: "revalidation" as const,
            reason: "mergeability_changed" as const,
            message: `Pull request mergeability changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        return {
          _tag: "needs_human" as const,
          reason: "merge_rejected" as const,
          message: `Azure DevOps rejected the unchanged, open, green, mergeable pull request for ${repository.projectPath}:${headRefName}`,
        } satisfies MergePullRequestResult
      },
    ),
    ensureIssueCompletedWithSummary: Effect.fn(
      "AzureDevOpsService.ensureIssueCompletedWithSummary",
    )(function* (repository, issueNumber, workItemId, summaryMarkdown) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        return yield* new AzureDevOpsRequestError({
          message: `Invalid Issue number for ${repository.projectPath}: ${String(issueNumber)}`,
        })
      }
      if (typeof workItemId !== "string" || workItemId.trim() === "") {
        return yield* new AzureDevOpsRequestError({
          message: `Invalid Work Item id for ${repository.projectPath}#${issueNumber}`,
        })
      }
      if (
        typeof summaryMarkdown !== "string" ||
        summaryMarkdown.trim() === ""
      ) {
        return yield* new AzureDevOpsRequestError({
          message: `Empty completion summary for ${repository.projectPath}#${issueNumber}`,
        })
      }
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }

      const marker = workItemCompletionMarker(workItemId)
      const issueRef = `${repository.projectPath}#${issueNumber}`

      const workItem = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          workItemPath(identity, issueNumber),
          `Failed to load Work Item ${issueRef}`,
        ).pipe(
          Effect.map((value) => decode(WorkItemStateSchema, value)),
          Effect.mapError((error) =>
            error instanceof AzureDevOpsRequestError
              ? error
              : requestError(
                  `Azure DevOps returned an invalid Work Item for ${issueRef}`,
                  error,
                ),
          ),
        ),
      )

      const comments = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          workItemCommentsPath(identity, issueNumber),
          `Failed to list comments for Work Item ${issueRef}`,
          { apiVersion: COMMENTS_API_VERSION },
        ).pipe(
          Effect.map((value) => decode(CommentListSchema, value).comments),
          Effect.mapError((error) =>
            error instanceof AzureDevOpsRequestError
              ? error
              : requestError(
                  `Azure DevOps returned invalid comments for ${issueRef}`,
                  error,
                ),
          ),
        ),
      )
      const hasMarkedComment = comments.some(
        (comment) =>
          typeof comment.text === "string" && comment.text.includes(marker),
      )

      if (!hasMarkedComment) {
        const body = `${summaryMarkdown.trimEnd()}\n\n${marker}`
        const posted = yield* unavailableOn404(
          repository,
          requestUnknown(
            identity.organization,
            workItemCommentsPath(identity, issueNumber),
            `Failed to post completion summary on Work Item ${issueRef}`,
            {
              method: "POST",
              body: { text: body },
              apiVersion: COMMENTS_API_VERSION,
            },
          ).pipe(
            Effect.map((value) => decode(CommentSchema, value)),
            Effect.mapError((error) =>
              error instanceof AzureDevOpsRequestError
                ? error
                : requestError(
                    `Azure DevOps returned an invalid comment after posting on ${issueRef}`,
                    error,
                  ),
            ),
          ),
        )
        if (typeof posted.text !== "string" || !posted.text.includes(marker)) {
          return yield* new AzureDevOpsRequestError({
            message: `Azure DevOps did not return a marked completion comment for ${issueRef}`,
          })
        }
      }

      if (!isOpenState(workItem.fields["System.State"])) {
        return
      }

      // No single "Closed" state name is guaranteed across process
      // templates: resolve the work item type's actual Completed-category
      // state, falling back to the common "Closed" literal. The lookup is
      // best-effort — any failure (network, decode, an unexpected 404 on a
      // type name, etc.) falls back to the literal rather than failing the
      // whole close-out, since the fallback already matches this codebase's
      // existing `CLOSED_STATE_NAMES` read-side heuristic.
      const workItemType = workItem.fields["System.WorkItemType"]?.trim()
      let targetStateName = "Closed"
      if (workItemType !== undefined && workItemType !== "") {
        const statesResult = yield* requestUnknown(
          identity.organization,
          workItemTypeStatesPath(identity, workItemType),
          `Failed to load states for Work Item type ${workItemType} on ${repository.projectPath}`,
        ).pipe(
          Effect.flatMap((value) =>
            // Decode failures must land in the typed error channel (not a
            // thrown defect) so Effect.result below can actually observe and
            // fall back on them, matching the doc comment above.
            Effect.try({
              try: () => decode(WorkItemTypeStateListSchema, value).value,
              catch: (cause) =>
                requestError(
                  `Azure DevOps returned invalid Work Item type states for ${repository.projectPath}`,
                  cause,
                ),
            }),
          ),
          Effect.result,
        )
        if (Result.isSuccess(statesResult)) {
          const completed = statesResult.success.find(
            (state) =>
              (state.category ?? "").trim().toLowerCase() === "completed",
          )
          if (completed !== undefined) {
            targetStateName = completed.name
          }
        }
      }

      const closed = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          workItemPath(identity, issueNumber),
          `Failed to close Work Item ${issueRef}`,
          {
            method: "PATCH",
            contentType: "application/json-patch+json",
            body: [
              {
                op: "add",
                path: "/fields/System.State",
                value: targetStateName,
              },
            ],
          },
        ).pipe(
          Effect.map((value) => decode(WorkItemStateSchema, value)),
          Effect.mapError((error) =>
            error instanceof AzureDevOpsRequestError
              ? error
              : requestError(
                  `Azure DevOps returned an invalid Work Item after closing ${issueRef}`,
                  error,
                ),
          ),
        ),
      )
      if (isOpenState(closed.fields["System.State"])) {
        return yield* new AzureDevOpsRequestError({
          message: `Work Item ${issueRef} is still open after close`,
        })
      }
    }),
    closeOpenPullRequestsForBranch: Effect.fn(
      "AzureDevOpsService.closeOpenPullRequestsForBranch",
    )(function* (repository, headRefName) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const open = yield* listPullRequestsForBranch(
        repository,
        identity,
        headRefName,
      )
      for (const pr of open) {
        // Missing PR between list and close is success (idempotent cleanup).
        const closeResult = yield* requestUnknown(
          identity.organization,
          pullRequestsPath(identity, `/${pr.pullRequestId}`),
          `Failed to close pull request ${pr.pullRequestId} for ${repository.projectPath}`,
          { method: "PATCH", body: { status: "abandoned" } },
        ).pipe(Effect.asVoid, Effect.result)
        if (closeResult._tag === "Success") continue
        if (closeResult.failure.statusCode === 404) continue
        return yield* closeResult.failure
      }
    }),
    deleteBranch: Effect.fn("AzureDevOpsService.deleteBranch")(
      function* (repository, branchName) {
        const identity = splitAzureDevOpsProjectPath(repository.projectPath)
        if (identity === null) {
          return yield* invalidProjectPath(repository)
        }
        const fullRef = toFullRefName(branchName)
        const filterValue = `heads/${branchFromRefName(fullRef)}`
        const listed = yield* requestUnknown(
          identity.organization,
          `${refsPath(identity)}?filter=${encodeURIComponent(filterValue)}`,
          `Failed to list refs for ${branchName} on ${repository.projectPath}`,
        ).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => decode(RefListSchema, value).value,
              catch: (cause) =>
                requestError(
                  `Azure DevOps returned invalid ref data for ${repository.projectPath}`,
                  cause,
                ),
            }),
          ),
        )
        const existing = listed.find((ref) => ref.name === fullRef)
        if (existing === undefined) {
          // Already deleted (idempotent cleanup).
          return
        }
        const updateResult = yield* requestUnknown(
          identity.organization,
          refsPath(identity),
          `Failed to delete branch ${branchName} on ${repository.projectPath}`,
          {
            method: "POST",
            body: [
              {
                name: fullRef,
                oldObjectId: existing.objectId,
                newObjectId: ZERO_OBJECT_ID,
              },
            ],
          },
        ).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => decode(RefUpdateListSchema, value).value,
              catch: (cause) =>
                requestError(
                  `Azure DevOps returned an invalid ref update result for ${repository.projectPath}`,
                  cause,
                ),
            }),
          ),
        )
        const updated = updateResult.find((ref) => ref.name === fullRef)
        if (updated === undefined || updated.updateStatus !== "succeeded") {
          return yield* new AzureDevOpsRequestError({
            message: `Azure DevOps did not delete branch ${branchName} on ${repository.projectPath}`,
          })
        }
      },
    ),
  } satisfies AzureDevOpsServiceShape
}

export const makeAzureDevOpsServiceFromToken = (
  token: string,
  fetchImpl: AzureDevOpsFetch = fetch,
): AzureDevOpsServiceShape =>
  makeAzureDevOpsService({ token, fetch: fetchImpl })

/**
 * Helper-process Live layer: reads `AZURE_DEVOPS_EXT_PAT` from the
 * environment. Keymaxxer injects the named vault secret aliased as
 * `AZURE_DEVOPS_EXT_PAT` so the raw token never enters the Harness process.
 */
export const AzureDevOpsServiceLive = Layer.effect(
  AzureDevOpsService,
  Effect.gen(function* () {
    const token = yield* Config.redacted(AZURE_DEVOPS_PAT_ENV_VAR)
    return makeAzureDevOpsServiceFromToken(Redacted.value(token))
  }),
)
