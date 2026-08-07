import { join } from "node:path"
import {
  Config,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Result,
  Schedule,
  Schema,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import {
  type FieldsSelection,
  createClient,
} from "../internal/generated/index.js"
import { GenqlError } from "../internal/generated/runtime/error.js"
import type {
  Mutation,
  MutationGenqlSelection,
  Query,
  QueryGenqlSelection,
} from "../internal/generated/schema.js"
import {
  type AutomatedReviewEvidenceCheck,
  type AutomatedReviewEvidenceObservation,
  GREEN_NO_REVIEW_EVIDENCE_REASON,
  inspectReviewerJobSteps,
  isRecognizedAutomatedReviewerLogin,
  isRecognizedAutomatedReviewerName,
} from "./automated-review-evidence.js"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  type GitHubThrottledError,
  isGitHubThrottledError,
} from "./errors.js"
import { GitHubService, type GitHubServiceShape } from "./github-service.js"
import {
  githubThrottleFromResponse,
  githubThrottleFromSuccessfulResponse,
} from "./github-throttle.js"
import type {
  GitHubIssueReference,
  GitHubIssueState,
  GitHubPullRequestLifecycleState,
  GitHubPullRequestReference,
  GitHubRepository,
  MergePullRequestResult,
  PrStatusCheckDiagnostic,
  PrStatusCheckDiagnosticSource,
  PrStatusCheckDiagnosticsOptions,
  PrStatusCheckDiagnosticsRequest,
  PullRequestCheckStatus,
  ReadyLabeledIssue,
  TerminalPrStatusCheck,
} from "./types.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const GITHUB_API_URL = "https://api.github.com"

class GitHubApiRepositoryUnavailableError extends Schema.TaggedErrorClass<GitHubApiRepositoryUnavailableError>()(
  "GitHubApiRepositoryUnavailableError",
  {
    owner: Schema.String,
    name: Schema.String,
  },
) {}
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100
const REQUEST_TIMEOUT = "30 seconds"
const DEFAULT_MAX_EXCERPT_CHARS = 12_000

class GitHubHttpError extends Error {
  constructor(input: {
    readonly statusCode: number
    readonly headers: Headers
    readonly message: string
  }) {
    super(input.message)
    this.statusCode = input.statusCode
    this.headers = input.headers
  }

  readonly statusCode: number
  readonly headers: Headers
}

export interface GitHubGraphqlClient {
  readonly query: <R extends QueryGenqlSelection>(
    request: R & { readonly __name?: string },
    signal?: AbortSignal,
  ) => Promise<FieldsSelection<Query, R>>
  readonly mutation?: <R extends MutationGenqlSelection>(
    request: R & { readonly __name?: string },
    signal?: AbortSignal,
  ) => Promise<FieldsSelection<Mutation, R>>
}

type GitHubFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>

/** Observes explicit, non-secret quota evidence from successful responses. */
export type GitHubThrottleObserver = (throttle: GitHubThrottledError) => void

const githubRequest = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestError | GitHubThrottledError> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => {
      if (isGitHubThrottledError(cause)) return cause
      const throttle = githubThrottleFromResponse({
        statusCode: cause instanceof GitHubHttpError ? cause.statusCode : 0,
        headers:
          cause instanceof GitHubHttpError ? cause.headers : new Headers(),
        message: cause instanceof Error ? cause.message : "",
      })
      if (throttle !== undefined) return throttle
      return new GitHubRequestError({
        message,
        cause,
        ...(cause instanceof GitHubHttpError
          ? {
              statusCode: cause.statusCode,
              retryable: cause.statusCode >= 500,
            }
          : cause instanceof GenqlError
            ? { retryable: false }
            : { retryable: true }),
      })
    },
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(
        new GitHubRequestError({
          message: `${message} timed out`,
          cause,
          retryable: true,
        }),
      ),
    ),
  )

const githubQuery = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestError | GitHubThrottledError> =>
  githubRequest(message, request).pipe(
    Effect.retry({
      schedule: Schedule.addDelay(Schedule.recurs(2), () =>
        Effect.succeed(Duration.millis(500)),
      ),
      while: (error) =>
        error._tag === "GitHubRequestError" && error.retryable === true,
    }),
  )

interface GitHubApiCommit {
  readonly oid?: unknown
  readonly pushedDate?: unknown
}

interface GitHubApiPullRequestCommit {
  readonly commit?: GitHubApiCommit | null
}

interface GitHubApiPullRequest {
  readonly state: unknown
  readonly merged: unknown
  readonly isDraft?: unknown
  readonly createdAt?: unknown
  readonly headRefOid?: unknown
  readonly baseRefName: unknown
  readonly mergeable: unknown
  readonly commits?: {
    readonly nodes?: readonly (GitHubApiPullRequestCommit | null)[] | null
  } | null
  readonly statusCheckRollup: {
    readonly state: unknown
  } | null
}

interface GitHubMergePullRequestSnapshot {
  readonly state: unknown
  readonly merged: unknown
  readonly headRefOid: unknown
  readonly mergeable: unknown
  readonly statusCheckRollup: { readonly state: unknown } | null
}

const isGitHubStatusCheckState = (
  state: unknown,
): state is "SUCCESS" | "FAILURE" | "ERROR" | "EXPECTED" | "PENDING" =>
  state === "SUCCESS" ||
  state === "FAILURE" ||
  state === "ERROR" ||
  state === "EXPECTED" ||
  state === "PENDING"

const isMergeGraphqlRejection = (error: GenqlError): boolean => {
  const message = error.message.toLowerCase()
  return (
    message.includes("head branch was modified") ||
    message.includes("pull request is not mergeable") ||
    message.includes("protected branch") ||
    message.includes("required status check") ||
    message.includes("required approving review") ||
    message.includes("merging is blocked") ||
    message.includes("merge is not allowed")
  )
}

interface GitHubRestCheckRun {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
}

interface GitHubRestWorkflowRun {
  readonly id?: unknown
  readonly name?: unknown
}

interface GitHubRestJob {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
  readonly steps?:
    | readonly {
        readonly name?: unknown
        readonly status?: unknown
        readonly conclusion?: unknown
      }[]
    | null
}

interface GitHubRestLoginAuthor {
  readonly login?: unknown
}

interface GitHubRestCommitStatus {
  readonly id?: unknown
  readonly node_id?: unknown
  readonly context?: unknown
  readonly state?: unknown
}

/** Load terminal check executions for a commit (REST Checks, or Actions fallback). */
export type ListTerminalChecksForCommit = (
  repository: { owner: string; name: string },
  headSha: string,
  signal?: AbortSignal,
) => Promise<readonly TerminalPrStatusCheck[]>

/** Load harness diagnostics for red PR Status Checks (Actions job logs). */
export type LoadPrStatusCheckDiagnostics = (
  repository: { owner: string; name: string },
  checks: readonly PrStatusCheckDiagnosticsRequest[],
  options: PrStatusCheckDiagnosticsOptions,
  signal?: AbortSignal,
) => Effect.Effect<
  readonly PrStatusCheckDiagnostic[],
  GitHubRequestError | GitHubThrottledError
>

/** Rerun an entire GitHub Actions workflow run. */
export type RerunWorkflowRun = (
  repository: { owner: string; name: string },
  workflowRunId: number,
  signal?: AbortSignal,
) => Promise<void>

/** Observe automated-review evidence for a green Status Check Handoff. */
export type ObserveAutomatedReviewEvidence = (
  repository: { owner: string; name: string },
  headRefName: string,
  checks: readonly AutomatedReviewEvidenceCheck[],
  signal?: AbortSignal,
) => Effect.Effect<
  AutomatedReviewEvidenceObservation,
  GitHubRequestError | GitHubThrottledError
>

const emptyTerminalChecks: readonly TerminalPrStatusCheck[] = []

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
/** Non-blank string without trimming the decoded value. */
const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)
const HttpUrlString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      try {
        new URL(value)
        return undefined
      } catch {
        return "Invalid URL"
      }
    }),
  ),
)

/** Schema-decode unknown API values; SchemaError is reified at Effect.try boundaries. */
const decodeSync = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

/** Decode external GraphQL data into a typed request failure, never a defect. */
const decodeGitHubResponse = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
  message: string,
): Effect.Effect<S["Type"], GitHubRequestError> =>
  Effect.try({
    try: () => decodeSync(schema, value),
    catch: (cause) => new GitHubRequestError({ message, cause }),
  })

const GitHubIssueStateSchema = Schema.Literals(["OPEN", "CLOSED"])
const GitHubMergeableSchema = Schema.Literals([
  "MERGEABLE",
  "CONFLICTING",
  "UNKNOWN",
])
const GitHubStatusCheckStateSchema = Schema.Literals([
  "SUCCESS",
  "FAILURE",
  "ERROR",
  "EXPECTED",
  "PENDING",
])
const GitHubIssueReferenceSchema = Schema.Struct({
  number: PositiveInt,
  url: HttpUrlString,
})
const GitHubRepositoryNameSchema = Schema.Struct({
  nameWithOwner: RequiredString,
})
const GitHubPullRequestCheckFieldsSchema = Schema.Struct({
  baseRefName: RequiredString,
  mergeable: GitHubMergeableSchema,
  merged: Schema.Boolean,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  statusCheckRollup: Schema.NullOr(
    Schema.Struct({
      state: GitHubStatusCheckStateSchema,
    }),
  ),
})
const RestCheckExecutionSchema = Schema.Struct({
  id: Schema.Int,
  name: RequiredString,
  status: Schema.Unknown,
  conclusion: Schema.optionalKey(Schema.Unknown),
})
const RestCommitStatusSchema = Schema.Struct({
  context: RequiredString,
  state: Schema.Unknown,
  id: Schema.optionalKey(Schema.Unknown),
  node_id: Schema.optionalKey(Schema.Unknown),
})
const ClosingPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  isDraft: Schema.Boolean,
  state: Schema.Unknown,
  merged: Schema.Unknown,
  repository: GitHubRepositoryNameSchema,
})
const ReadyLabeledIssueFieldsSchema = Schema.Struct({
  number: PositiveInt,
  title: RequiredString,
  body: Schema.String,
  url: HttpUrlString,
  createdAt: Schema.DateFromString,
  state: GitHubIssueStateSchema,
  author: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
  subIssuesSummary: Schema.Struct({
    total: NonNegativeInt,
  }),
})
const AuthenticatedUserLoginSchema = Schema.Struct({
  login: RequiredString,
})
const CleanupPullRequestPageSchema = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequests: Schema.Struct({
        nodes: Schema.NullOr(
          Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                id: RequiredString,
                state: Schema.Literal("OPEN"),
              }),
            ),
          ),
        ),
        pageInfo: Schema.Struct({
          endCursor: Schema.NullOr(Schema.String),
          hasNextPage: Schema.Boolean,
        }),
      }),
    }),
  ),
})
const CleanupBranchRefResultSchema = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      ref: Schema.NullOr(Schema.Struct({ id: RequiredString })),
    }),
  ),
})
const CleanupPullRequestMutationSchema = Schema.Struct({
  updatePullRequest: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({ state: Schema.Literal("CLOSED") }),
      ),
    }),
  ),
})
const CleanupDeleteRefMutationSchema = Schema.Struct({
  deleteRef: Schema.NullOr(
    Schema.Struct({ clientMutationId: Schema.NullOr(Schema.String) }),
  ),
})
type CleanupPullRequestPage = typeof CleanupPullRequestPageSchema.Type
type CleanupBranchRefResult = typeof CleanupBranchRefResultSchema.Type
type CleanupPullRequestMutation = typeof CleanupPullRequestMutationSchema.Type

const uniqueTerminalChecks = (
  checks: readonly TerminalPrStatusCheck[],
): readonly TerminalPrStatusCheck[] => {
  const byId = new Map<string, TerminalPrStatusCheck>()
  for (const check of checks) {
    byId.set(check.externalId, check)
  }
  return [...byId.values()].sort((left, right) =>
    left.externalId.localeCompare(right.externalId),
  )
}

/**
 * Read the current PR head commit's push time. Invalid or mismatched API data
 * yields null so callers keep the conservative observation fallback.
 */
const parseHeadPushedAt = (pullRequest: GitHubApiPullRequest): Date | null => {
  const headRefOid = pullRequest.headRefOid
  if (typeof headRefOid !== "string" || headRefOid.trim() === "") {
    return null
  }
  const nodes = pullRequest.commits?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return null
  }
  const latest = nodes[nodes.length - 1]
  const commit = latest?.commit
  if (commit === null || commit === undefined) {
    return null
  }
  if (typeof commit.oid !== "string" || commit.oid !== headRefOid) {
    return null
  }
  const pushedDate = commit.pushedDate
  if (pushedDate === null || pushedDate === undefined) {
    return null
  }
  if (typeof pushedDate !== "string") {
    return null
  }
  const parsed = new Date(pushedDate)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

const parsePrCreatedAt = (pullRequest: GitHubApiPullRequest): Date | null => {
  const createdAt = pullRequest.createdAt
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    return null
  }
  const parsed = new Date(createdAt)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

const parseIsDraft = (pullRequest: GitHubApiPullRequest): boolean | null => {
  if (pullRequest.isDraft === true) {
    return true
  }
  if (pullRequest.isDraft === false) {
    return false
  }
  return null
}

const headShaFromPullRequest = (
  pullRequest: GitHubApiPullRequest | null | undefined,
): string | null => {
  if (pullRequest === null || pullRequest === undefined) {
    return null
  }
  return typeof pullRequest.headRefOid === "string" &&
    pullRequest.headRefOid.trim() !== ""
    ? pullRequest.headRefOid
    : null
}

const emptyCheckSnapshotFields = {
  mergeability: "unknown" as const,
  baseRefName: null,
  headPushedAt: null,
  headSha: null,
  createdAt: null,
  isDraft: null,
}

const toPullRequestCheckStatus = (
  pullRequest: GitHubApiPullRequest | null | undefined,
  terminalChecks: readonly TerminalPrStatusCheck[] = emptyTerminalChecks,
): PullRequestCheckStatus => {
  if (pullRequest === null || pullRequest === undefined) {
    return {
      _tag: "pending",
      terminalChecks: emptyTerminalChecks,
      ...emptyCheckSnapshotFields,
    }
  }
  const decoded = decodeSync(GitHubPullRequestCheckFieldsSchema, pullRequest)
  const mergeability =
    decoded.mergeable === "MERGEABLE"
      ? "mergeable"
      : decoded.mergeable === "CONFLICTING"
        ? "conflicting"
        : "unknown"
  const snapshot = {
    mergeability,
    baseRefName: decoded.baseRefName,
    headPushedAt: parseHeadPushedAt(pullRequest),
    headSha: headShaFromPullRequest(pullRequest),
    createdAt: parsePrCreatedAt(pullRequest),
    isDraft: parseIsDraft(pullRequest),
  } as const
  if (decoded.merged) {
    return { _tag: "succeeded", terminalChecks, ...snapshot }
  }
  if (decoded.state === "CLOSED") {
    return { _tag: "closed", ...snapshot }
  }
  if (decoded.statusCheckRollup === null) {
    return { _tag: "no_checks", ...snapshot }
  }
  const state = decoded.statusCheckRollup.state
  if (state === "SUCCESS") {
    return { _tag: "succeeded", terminalChecks, ...snapshot }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return { _tag: "failed", terminalChecks, ...snapshot }
  }
  if (state === "EXPECTED") {
    return { _tag: "expected", terminalChecks, ...snapshot }
  }
  return { _tag: "pending", terminalChecks, ...snapshot }
}

const normalizeRestToken = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") {
    return null
  }
  return value.trim().toUpperCase()
}

const mapRestCheckExecution = (check: {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
}): TerminalPrStatusCheck | null => {
  if (normalizeRestToken(check.status) !== "COMPLETED") {
    return null
  }
  const decoded = decodeSync(RestCheckExecutionSchema, check)
  const conclusion = normalizeRestToken(decoded.conclusion)
  if (conclusion === "SUCCESS") {
    return {
      externalId: `actions-job:${decoded.id}`,
      name: decoded.name,
      outcome: "green",
    }
  }
  if (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE"
  ) {
    return {
      externalId: `actions-job:${decoded.id}`,
      name: decoded.name,
      outcome: "red",
    }
  }
  return null
}

const mapRestCommitStatus = (
  status: GitHubRestCommitStatus,
): TerminalPrStatusCheck | null => {
  const decoded = decodeSync(RestCommitStatusSchema, status)
  const state = normalizeRestToken(decoded.state)
  if (state === "PENDING" || state === "EXPECTED") {
    return null
  }
  const identity =
    typeof decoded.node_id === "string" && decoded.node_id.trim() !== ""
      ? decoded.node_id
      : typeof decoded.id === "number" && Number.isSafeInteger(decoded.id)
        ? String(decoded.id)
        : decoded.context
  if (state === "SUCCESS") {
    return {
      externalId: `status:${identity}`,
      name: decoded.context,
      outcome: "green",
    }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return {
      externalId: `status:${identity}`,
      name: decoded.context,
      outcome: "red",
    }
  }
  decodeSync(
    Schema.Literals(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
    state,
  )
  return null
}

interface GitHubApiIssue {
  readonly number: unknown
  readonly title: unknown
  readonly body: unknown
  readonly url: unknown
  readonly createdAt: unknown
  readonly state: unknown
  readonly author?: { readonly login: unknown } | null
  readonly parent: GitHubApiIssueParent | null
  readonly subIssuesSummary: { readonly total: unknown }
  readonly subIssues: GitHubApiSubIssueConnection
  readonly blockedBy: GitHubApiIssueConnection
  readonly closedByPullRequestsReferences?: GitHubApiPullRequestConnection
}

interface GitHubApiPullRequestReference {
  readonly number: unknown
  readonly state: unknown
  readonly merged: unknown
  readonly isDraft: unknown
  readonly repository: GitHubApiRepositoryReference
}

interface GitHubApiPullRequestConnection {
  readonly nodes: readonly (GitHubApiPullRequestReference | null)[] | null
  readonly pageInfo: {
    readonly endCursor: string | null
    readonly hasNextPage: boolean
  }
}

interface GitHubApiIssueConnection {
  readonly nodes: readonly (GitHubApiIssueDependency | null)[] | null
  readonly pageInfo: {
    readonly endCursor: string | null
    readonly hasNextPage: boolean
  }
}

interface GitHubApiIssueReference {
  readonly number: unknown
  readonly url: unknown
}

interface GitHubApiIssueDependency extends GitHubApiIssueReference {
  readonly state: unknown
}

interface GitHubApiRepositoryReference {
  readonly nameWithOwner: unknown
}

interface GitHubApiIssueParent extends GitHubApiIssueReference {
  readonly state: unknown
  readonly repository: GitHubApiRepositoryReference
  readonly parent:
    | (GitHubApiIssueReference & {
        readonly repository: GitHubApiRepositoryReference
      })
    | null
}

interface GitHubApiSubIssue extends GitHubApiIssueReference {
  readonly repository: GitHubApiRepositoryReference
  readonly subIssuesSummary: { readonly total: unknown }
}

interface GitHubApiSubIssueConnection {
  readonly nodes: readonly (GitHubApiSubIssue | null)[] | null
  readonly pageInfo: {
    readonly endCursor: string | null
    readonly hasNextPage: boolean
  }
}

interface InternalIssueParent extends GitHubIssueReference {
  readonly state: GitHubIssueState
  readonly repository: string
  readonly parent:
    | (GitHubIssueReference & { readonly repository: string })
    | null
}

interface InternalReadyLabeledIssue
  extends Omit<
    ReadyLabeledIssue,
    "parent" | "parentPosition" | "hierarchySupported"
  > {
  readonly parent: InternalIssueParent | null
  readonly hasUnsupportedDescendants: boolean
}

const toIssueReference = (
  issue: GitHubApiIssueReference,
): GitHubIssueReference => {
  const decoded = decodeSync(GitHubIssueReferenceSchema, issue)
  return { number: decoded.number, url: decoded.url }
}

const mapBlockedByPage = (
  connection: GitHubApiIssueConnection,
): readonly GitHubIssueReference[] =>
  (connection.nodes ?? [])
    .filter((issue) => issue !== null)
    .filter((issue) => toIssueState(issue.state) === "OPEN")
    .map(toIssueReference)

const toClosingPullRequestState = (
  state: unknown,
  merged: unknown,
): GitHubPullRequestLifecycleState => {
  if (merged === true || state === "MERGED") {
    return "MERGED"
  }
  decodeSync(Schema.Literal(false), merged)
  return decodeSync(Schema.Literals(["OPEN", "CLOSED"]), state)
}

const mapClosingPullRequestPage = (
  connection: GitHubApiPullRequestConnection | undefined,
): readonly GitHubPullRequestReference[] =>
  (connection?.nodes ?? [])
    .filter((pullRequest) => pullRequest !== null)
    .map((pullRequest) => {
      const decoded = decodeSync(ClosingPullRequestSchema, pullRequest)
      return {
        number: decoded.number,
        repository: decoded.repository.nameWithOwner,
        state: toClosingPullRequestState(decoded.state, decoded.merged),
        isDraft: decoded.isDraft,
      }
    })

const toRepositoryName = (repository: GitHubApiRepositoryReference): string =>
  decodeSync(GitHubRepositoryNameSchema, repository).nameWithOwner

const toIssueState = (state: unknown): GitHubIssueState =>
  decodeSync(GitHubIssueStateSchema, state)

const toIssueParent = (parent: GitHubApiIssueParent): InternalIssueParent => ({
  ...toIssueReference(parent),
  state: toIssueState(parent.state),
  repository: toRepositoryName(parent.repository),
  parent:
    parent.parent === null
      ? null
      : {
          ...toIssueReference(parent.parent),
          repository: toRepositoryName(parent.parent.repository),
        },
})

const pageHasUnsupportedSubIssue = (
  connection: GitHubApiSubIssueConnection,
  repositoryName: string,
): boolean => {
  if (connection.nodes === null) return true

  return connection.nodes.some((issue) => {
    if (issue === null) return true
    toIssueReference(issue)
    const childRepository = toRepositoryName(issue.repository)
    const total = decodeSync(
      Schema.Struct({ total: NonNegativeInt }),
      issue.subIssuesSummary,
    ).total
    return (
      childRepository.toLowerCase() !== repositoryName.toLowerCase() ||
      total > 0
    )
  })
}

const recordSubIssuePositions = (
  connection: GitHubApiSubIssueConnection,
  positions: Map<string, number>,
  offset: number,
): number => {
  for (const [index, issue] of (connection.nodes ?? []).entries()) {
    if (issue !== null) {
      positions.set(toIssueReference(issue).url.toLowerCase(), offset + index)
    }
  }
  return offset + (connection.nodes?.length ?? 0)
}

const toIssueAuthor = (
  author: { readonly login: string } | null | undefined,
): string | null => {
  if (author === null || author === undefined) {
    return null
  }
  const login = author.login.trim()
  return login === "" ? null : login
}

const toReadyLabeledIssue = (
  issue: GitHubApiIssue,
  repositoryName: string,
): InternalReadyLabeledIssue => {
  const decoded = decodeSync(ReadyLabeledIssueFieldsSchema, {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    createdAt: issue.createdAt,
    state: issue.state,
    ...(issue.author === undefined ? {} : { author: issue.author }),
    subIssuesSummary: issue.subIssuesSummary,
  })

  return {
    number: decoded.number,
    title: decoded.title,
    body: decoded.body,
    url: decoded.url,
    createdAt: decoded.createdAt,
    state: decoded.state,
    author: toIssueAuthor(decoded.author),
    parent: issue.parent === null ? null : toIssueParent(issue.parent),
    hasChildren: decoded.subIssuesSummary.total > 0,
    hasUnsupportedDescendants: pageHasUnsupportedSubIssue(
      issue.subIssues,
      repositoryName,
    ),
    blockedBy: mapBlockedByPage(issue.blockedBy),
    closingPullRequests: mapClosingPullRequestPage(
      issue.closedByPullRequestsReferences,
    ),
  }
}

const sortDependencies = (
  dependencies: readonly GitHubIssueReference[],
): readonly GitHubIssueReference[] =>
  [
    ...new Map(
      dependencies.map((dependency) => [dependency.url, dependency]),
    ).values(),
  ].sort(
    (left, right) =>
      left.number - right.number || left.url.localeCompare(right.url),
  )

const parseDiagnosticSource = (
  externalId: string,
): {
  readonly source: PrStatusCheckDiagnosticSource
  readonly actionsJobId: number | null
} => {
  if (externalId.startsWith("actions-job:")) {
    const raw = externalId.slice("actions-job:".length)
    const actionsJobId = Number(raw)
    if (Number.isSafeInteger(actionsJobId) && actionsJobId > 0) {
      return { source: "actions-job", actionsJobId }
    }
    return { source: "actions-job", actionsJobId: null }
  }
  if (externalId.startsWith("status:")) {
    return { source: "status", actionsJobId: null }
  }
  return { source: "unknown", actionsJobId: null }
}

const boundLogExcerpt = (logText: string, maxExcerptChars: number): string => {
  if (logText.length <= maxExcerptChars) {
    return logText
  }
  return logText.slice(logText.length - maxExcerptChars)
}

const safeLogFileName = (externalId: string): string =>
  `${externalId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.log`

/** Hidden HTML comment marker tying a completion summary to a Work Item. */
const workItemCompletionMarker = (workItemId: string): string =>
  `<!-- ready-for-agent:work-item:${workItemId} -->`

type OpenPullRequestDetails = {
  readonly id: string
  readonly number: number
  readonly isDraft: boolean
  readonly title: string
  readonly body: string
}

const findOpenPullRequestDetailsImpl = (
  client: GitHubGraphqlClient,
  repository: { readonly owner: string; readonly name: string },
  headRefName: string,
): Effect.Effect<
  OpenPullRequestDetails | null,
  | GitHubApiRepositoryUnavailableError
  | GitHubRequestError
  | GitHubThrottledError
> =>
  Effect.gen(function* () {
    const result = yield* githubQuery(
      `Failed to find open pull request for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              pullRequests: {
                __args: {
                  first: 1,
                  states: ["OPEN"],
                  headRefName,
                },
                nodes: {
                  id: true,
                  number: true,
                  isDraft: true,
                  title: true,
                  body: true,
                },
              },
            },
          },
          signal,
        ),
    )
    if (result.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const node = result.repository.pullRequests.nodes?.[0]
    if (node === null || node === undefined) {
      return null
    }
    const number = node.number
    if (!Number.isSafeInteger(number) || Number(number) <= 0) {
      return null
    }
    const id = typeof node.id === "string" ? node.id.trim() : ""
    // id is required for updatePullRequest; callers that only need a number use
    // findOpenPullRequestNumberImpl (number-only query).
    if (id === "") {
      return null
    }
    return {
      id,
      number: Number(number),
      isDraft: node.isDraft === true,
      title: typeof node.title === "string" ? node.title : "",
      body: typeof node.body === "string" ? node.body : "",
    }
  })

const findOpenPullRequestNumberImpl = (
  client: GitHubGraphqlClient,
  repository: { readonly owner: string; readonly name: string },
  headRefName: string,
): Effect.Effect<
  number | null,
  | GitHubApiRepositoryUnavailableError
  | GitHubRequestError
  | GitHubThrottledError
> =>
  Effect.gen(function* () {
    // Number-only query: do not require GraphQL id (update paths use details).
    const result = yield* githubQuery(
      `Failed to find open pull request for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              pullRequests: {
                __args: {
                  first: 1,
                  states: ["OPEN"],
                  headRefName,
                },
                nodes: { number: true },
              },
            },
          },
          signal,
        ),
    )
    if (result.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const number = result.repository.pullRequests.nodes?.[0]?.number
    if (!Number.isSafeInteger(number) || Number(number) <= 0) {
      return null
    }
    return Number(number)
  })

type GitHubApiRepository = {
  readonly owner: string
  readonly name: string
}

type GitHubApiServiceShape = {
  [K in keyof GitHubServiceShape]: GitHubServiceShape[K] extends (
    repository: GitHubRepository,
    ...args: infer Args
  ) => infer Result
    ? Result extends Effect.Effect<infer A, infer E, infer R>
      ? (
          repository: GitHubApiRepository,
          ...args: Args
        ) => Effect.Effect<
          A,
          | Exclude<E, GitHubRepositoryUnavailableError>
          | GitHubApiRepositoryUnavailableError,
          R
        >
      : never
    : never
}

const makeGitHubApiService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
  rerunWorkflowRunImpl?: RerunWorkflowRun,
  observeAutomatedReviewEvidenceImpl?: ObserveAutomatedReviewEvidence,
): GitHubApiServiceShape => ({
  getAuthenticatedUserLogin: Effect.fn(
    "GitHubService.getAuthenticatedUserLogin",
  )(function* (_repository) {
    const result = yield* githubQuery(
      "Failed to resolve authenticated GitHub user",
      (signal) =>
        client.query(
          {
            viewer: {
              login: true,
            },
          },
          signal,
        ),
    )
    const decoded = yield* Effect.try({
      try: () => decodeSync(AuthenticatedUserLoginSchema, result.viewer),
      catch: (cause) =>
        new GitHubRequestError({
          message: "GitHub returned invalid authenticated user data",
          cause,
        }),
    })
    return decoded.login
  }),
  getPullRequestCheckStatus: Effect.fn(
    "GitHubService.getPullRequestCheckStatus",
  )(function* (repository, headRefName) {
    const result = yield* githubQuery(
      `Failed to get pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              pullRequests: {
                __args: {
                  first: 1,
                  headRefName,
                },
                nodes: {
                  state: true,
                  merged: true,
                  isDraft: true,
                  createdAt: true,
                  headRefOid: true,
                  baseRefName: true,
                  mergeable: true,
                  commits: {
                    __args: { last: 1 },
                    nodes: {
                      commit: {
                        oid: true,
                        pushedDate: true,
                      },
                    },
                  },
                  // Rollup state only — CheckRun contexts need Checks API access
                  // that fine-grained PATs cannot grant. Terminal details load via REST.
                  statusCheckRollup: { state: true },
                },
              },
            },
          },
          signal,
        ),
    )
    if (result.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const pullRequest = (result.repository.pullRequests.nodes?.[0] ??
      null) as GitHubApiPullRequest | null
    if (pullRequest === null) {
      return {
        _tag: "pending",
        terminalChecks: emptyTerminalChecks,
        ...emptyCheckSnapshotFields,
      }
    }

    let terminalChecks: readonly TerminalPrStatusCheck[] = emptyTerminalChecks
    const headSha = pullRequest.headRefOid
    if (
      listTerminalChecksForCommit !== undefined &&
      typeof headSha === "string" &&
      headSha.trim() !== "" &&
      pullRequest.statusCheckRollup !== null
    ) {
      terminalChecks = yield* githubQuery(
        `Failed to list terminal pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
        (signal) => listTerminalChecksForCommit(repository, headSha, signal),
      ).pipe(Effect.map(uniqueTerminalChecks))
    }

    return yield* Effect.try({
      try: () => toPullRequestCheckStatus(pullRequest, terminalChecks),
      catch: (cause) =>
        new GitHubRequestError({
          message: `GitHub returned invalid pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
          cause,
        }),
    })
  }),
  getPrStatusCheckDiagnostics: Effect.fn(
    "GitHubService.getPrStatusCheckDiagnostics",
  )(function* (repository, checks, options = {}) {
    if (checks.length === 0) {
      return []
    }
    if (loadPrStatusCheckDiagnostics === undefined) {
      return checks.map((check) => {
        const { source } = parseDiagnosticSource(check.externalId)
        return {
          externalId: check.externalId,
          name: check.name,
          source,
          htmlUrl: null,
          logFetch: {
            _tag: "unavailable" as const,
            reason: "PR Status Check diagnostics loader is not configured",
          },
        }
      })
    }
    return yield* loadPrStatusCheckDiagnostics(
      repository,
      checks,
      options,
    ).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new GitHubRequestError({
            message: `Failed to load PR Status Check diagnostics for ${repository.owner}/${repository.name} timed out`,
            cause,
          }),
        ),
      ),
    )
  }),
  observeAutomatedReviewEvidence: Effect.fn(
    "GitHubService.observeAutomatedReviewEvidence",
  )(function* (repository, headRefName, checks) {
    if (observeAutomatedReviewEvidenceImpl === undefined) {
      return {
        _tag: "ambiguous" as const,
        reason: "Automated review evidence observation is not configured",
      }
    }
    return yield* observeAutomatedReviewEvidenceImpl(
      repository,
      headRefName,
      checks,
    ).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new GitHubRequestError({
            message: `Failed to observe automated review evidence for ${repository.owner}/${repository.name}:${headRefName} timed out`,
            cause,
          }),
        ),
      ),
    )
  }),
  getPullRequestLifecycleStatus: Effect.fn(
    "GitHubService.getPullRequestLifecycleStatus",
  )(function* (repository, headRefName) {
    const result = yield* githubQuery(
      `Failed to get pull request lifecycle for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              pullRequests: {
                __args: {
                  first: 1,
                  headRefName,
                },
                nodes: {
                  state: true,
                  merged: true,
                },
              },
            },
          },
          signal,
        ),
    )
    if (result.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const pullRequest = result.repository.pullRequests.nodes?.[0]
    if (pullRequest === null || pullRequest === undefined) {
      return { _tag: "not_found" as const }
    }
    if (pullRequest.merged === true || pullRequest.state === "MERGED") {
      return { _tag: "merged" as const }
    }
    if (pullRequest.state === "CLOSED") {
      return { _tag: "closed" as const }
    }
    if (pullRequest.state === "OPEN") {
      return { _tag: "open" as const }
    }
    return yield* new GitHubRequestError({
      message: `GitHub returned an invalid pull request state for ${repository.owner}/${repository.name}:${headRefName}`,
    })
  }),
  getOpenPullRequestNumber: Effect.fn("GitHubService.getOpenPullRequestNumber")(
    function* (repository, headRefName) {
      const number = yield* findOpenPullRequestNumberImpl(
        client,
        repository,
        headRefName,
      )
      if (number === null) {
        return yield* new GitHubRequestError({
          message: `No open pull request found for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      return number
    },
  ),
  findOpenPullRequestNumber: Effect.fn(
    "GitHubService.findOpenPullRequestNumber",
  )(function* (repository, headRefName) {
    return yield* findOpenPullRequestNumberImpl(client, repository, headRefName)
  }),
  closeOpenPullRequestsAndDeleteBranch: Effect.fn(
    "GitHubService.closeOpenPullRequestsAndDeleteBranch",
  )(function* (repository, headRefName) {
    if (typeof headRefName !== "string" || headRefName.trim() === "") {
      return yield* new GitHubRequestError({
        message: `Invalid pull request head branch for ${repository.owner}/${repository.name}`,
      })
    }

    const pullRequestIds: string[] = []
    let cursor: string | null = null
    for (;;) {
      const afterCursor: string | null = cursor
      const page: CleanupPullRequestPage = yield* githubQuery(
        `Failed to list open pull requests for cleanup on ${repository.owner}/${repository.name}:${headRefName}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                pullRequests: {
                  __args: {
                    first: PAGE_SIZE,
                    states: ["OPEN" as const],
                    headRefName,
                    ...(afterCursor === null ? {} : { after: afterCursor }),
                  },
                  nodes: {
                    id: true,
                    state: true,
                  },
                  pageInfo: {
                    endCursor: true,
                    hasNextPage: true,
                  },
                },
              },
            },
            signal,
          ),
      ).pipe(
        Effect.flatMap((result) =>
          decodeGitHubResponse(
            CleanupPullRequestPageSchema,
            result,
            `GitHub returned invalid open pull request data while cleaning ${repository.owner}/${repository.name}:${headRefName}`,
          ),
        ),
      )
      if (page.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      for (const pullRequest of page.repository.pullRequests.nodes ?? []) {
        if (pullRequest === null) continue
        pullRequestIds.push(pullRequest.id)
      }
      const { pageInfo } = page.repository.pullRequests
      if (pageInfo.hasNextPage !== true) break
      if (
        typeof pageInfo.endCursor !== "string" ||
        pageInfo.endCursor.trim() === ""
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request page while cleaning ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      cursor = pageInfo.endCursor
    }

    if (pullRequestIds.length > 0) {
      const mutate = client.mutation
      if (mutate === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}`,
        })
      }
      for (const pullRequestId of pullRequestIds) {
        const mutation: CleanupPullRequestMutation = yield* githubRequest(
          `Failed to close pull request for cleanup on ${repository.owner}/${repository.name}:${headRefName}`,
          (signal) =>
            mutate(
              {
                updatePullRequest: {
                  __args: {
                    input: {
                      pullRequestId,
                      state: "CLOSED" as const,
                    },
                  },
                  pullRequest: {
                    state: true,
                  },
                },
              },
              signal,
            ),
        ).pipe(
          Effect.flatMap((response) =>
            decodeGitHubResponse(
              CleanupPullRequestMutationSchema,
              response,
              `GitHub returned invalid pull request closure data while cleaning ${repository.owner}/${repository.name}:${headRefName}`,
            ),
          ),
        )
        if (mutation.updatePullRequest?.pullRequest?.state !== "CLOSED") {
          return yield* new GitHubRequestError({
            message: `GitHub did not confirm pull request closure for ${repository.owner}/${repository.name}:${headRefName}`,
          })
        }
      }
    }

    const loadBranchRef = (): Effect.Effect<
      string | null,
      | GitHubRequestError
      | GitHubThrottledError
      | GitHubApiRepositoryUnavailableError
    > =>
      Effect.gen(function* () {
        const result: CleanupBranchRefResult = yield* githubQuery(
          `Failed to find remote branch for cleanup on ${repository.owner}/${repository.name}:${headRefName}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  ref: {
                    __args: {
                      qualifiedName: `refs/heads/${headRefName}`,
                    },
                    id: true,
                  },
                },
              },
              signal,
            ),
        ).pipe(
          Effect.flatMap((response) =>
            decodeGitHubResponse(
              CleanupBranchRefResultSchema,
              response,
              `GitHub returned invalid branch reference data while cleaning ${repository.owner}/${repository.name}:${headRefName}`,
            ),
          ),
        )
        if (result.repository === null) {
          return yield* new GitHubApiRepositoryUnavailableError(repository)
        }
        const ref = result.repository.ref
        if (ref === null) return null
        return ref.id
      })

    const refId = yield* loadBranchRef()
    if (refId === null) return
    const mutate = client.mutation
    if (mutate === undefined) {
      return yield* new GitHubRequestError({
        message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}`,
      })
    }
    yield* githubRequest(
      `Failed to delete remote branch for cleanup on ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        mutate(
          {
            deleteRef: {
              __args: { input: { refId } },
              clientMutationId: true,
            },
          },
          signal,
        ),
    ).pipe(
      Effect.flatMap((response) =>
        decodeGitHubResponse(
          CleanupDeleteRefMutationSchema,
          response,
          `GitHub returned invalid remote branch deletion data while cleaning ${repository.owner}/${repository.name}:${headRefName}`,
        ),
      ),
      Effect.filterOrFail(
        (result) => result.deleteRef !== null,
        () =>
          new GitHubRequestError({
            message: `GitHub did not confirm remote branch deletion for ${repository.owner}/${repository.name}:${headRefName}`,
          }),
      ),
      // A concurrent branch deletion is the same successful postcondition.
      // Revalidate only ordinary request failures: a throttle must propagate
      // immediately without spending another request.
      Effect.catchTag("GitHubRequestError", (error) =>
        loadBranchRef().pipe(
          Effect.flatMap((remainingRefId) =>
            remainingRefId === null ? Effect.void : Effect.fail(error),
          ),
        ),
      ),
    )
  }),
  createDraftPullRequest: Effect.fn("GitHubService.createDraftPullRequest")(
    function* (repository, input) {
      const repositoryMeta = yield* githubQuery(
        `Failed to resolve repository metadata for ${repository.owner}/${repository.name}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                id: true,
                defaultBranchRef: {
                  name: true,
                },
              },
            },
            signal,
          ),
      )
      if (repositoryMeta.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      const repositoryId = repositoryMeta.repository.id
      if (typeof repositoryId !== "string" || repositoryId.trim() === "") {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid repository id for ${repository.owner}/${repository.name}`,
        })
      }
      const defaultBase =
        repositoryMeta.repository.defaultBranchRef?.name?.trim() ?? ""
      const baseRefName =
        input.baseRefName !== undefined && input.baseRefName.trim() !== ""
          ? input.baseRefName.trim()
          : defaultBase
      if (baseRefName === "") {
        return yield* new GitHubRequestError({
          message: `Repository ${repository.owner}/${repository.name} has no default base branch`,
        })
      }
      if (client.mutation === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}`,
        })
      }
      const mutate = client.mutation
      const mutation = yield* githubRequest(
        `Failed to create draft pull request for ${repository.owner}/${repository.name}:${input.headRefName}`,
        (signal) =>
          mutate(
            {
              createPullRequest: {
                __args: {
                  input: {
                    repositoryId,
                    baseRefName,
                    headRefName: input.headRefName,
                    title: input.title,
                    body: input.body,
                    draft: true,
                  },
                },
                pullRequest: {
                  number: true,
                },
              },
            },
            signal,
          ),
      )
      const pullRequest = mutation.createPullRequest?.pullRequest
      const number = pullRequest?.number
      if (!Number.isSafeInteger(number) || Number(number) <= 0) {
        return yield* new GitHubRequestError({
          message: `GitHub did not return a pull request number after creating a draft for ${repository.owner}/${repository.name}:${input.headRefName}`,
        })
      }
      return Number(number)
    },
  ),
  updateOpenDraftPullRequestCopy: Effect.fn(
    "GitHubService.updateOpenDraftPullRequestCopy",
  )(function* (repository, headRefName, input) {
    const details = yield* findOpenPullRequestDetailsImpl(
      client,
      repository,
      headRefName,
    )
    if (details === null) {
      return null
    }
    if (details.isDraft !== true) {
      // Ready-for-review or human-edited non-draft: do not overwrite.
      return details.number
    }
    if (details.title === input.title && details.body === input.body) {
      return details.number
    }
    if (client.mutation === undefined) {
      // Open draft exists; copy update is best-effort.
      return details.number
    }
    const mutate = client.mutation
    // Mutation failures must not hide an existing open draft: callers treat the
    // returned number as postcondition success for Create PR reuse.
    yield* githubRequest(
      `Failed to update draft pull request #${details.number} for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        mutate(
          {
            updatePullRequest: {
              __args: {
                input: {
                  pullRequestId: details.id,
                  title: input.title,
                  body: input.body,
                },
              },
              pullRequest: {
                number: true,
              },
            },
          },
          signal,
        ),
    ).pipe(Effect.catch(() => Effect.void))
    return details.number
  }),
  countOpenNonDraftPullRequests: Effect.fn(
    "GitHubService.countOpenNonDraftPullRequests",
  )(function* (repository) {
    let count = 0
    let cursor: string | null = null
    for (;;) {
      const afterCursor: string | null = cursor
      const page = yield* githubQuery(
        `Failed to count open pull requests for ${repository.owner}/${repository.name}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                pullRequests: {
                  __args: {
                    first: PAGE_SIZE,
                    states: ["OPEN" as const],
                    ...(afterCursor === null ? {} : { after: afterCursor }),
                  },
                  nodes: {
                    isDraft: true,
                  },
                  pageInfo: {
                    endCursor: true,
                    hasNextPage: true,
                  },
                },
              },
            },
            signal,
          ),
      )
      if (page.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      const nodes = page.repository.pullRequests.nodes ?? []
      for (const node of nodes) {
        if (node !== null && node !== undefined && node.isDraft === false) {
          count += 1
        }
      }
      const pageInfo: {
        readonly endCursor?: string | null
        readonly hasNextPage: boolean
      } = page.repository.pullRequests.pageInfo
      if (
        !pageInfo.hasNextPage ||
        pageInfo.endCursor === null ||
        pageInfo.endCursor === undefined ||
        pageInfo.endCursor === ""
      ) {
        break
      }
      cursor = pageInfo.endCursor
    }
    return count
  }),
  markPullRequestReadyForReview: Effect.fn(
    "GitHubService.markPullRequestReadyForReview",
  )(function* (repository, headRefName) {
    const result = yield* githubQuery(
      `Failed to find pull request for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              pullRequests: {
                __args: {
                  first: 1,
                  headRefName,
                },
                nodes: {
                  id: true,
                  isDraft: true,
                  state: true,
                },
              },
            },
          },
          signal,
        ),
    )
    if (result.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const pullRequest = result.repository.pullRequests.nodes?.[0]
    if (pullRequest === null || pullRequest === undefined) {
      return yield* new GitHubRequestError({
        message: `No pull request found for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (typeof pullRequest.id !== "string" || pullRequest.id.trim() === "") {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid pull request id for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (pullRequest.isDraft !== true && pullRequest.isDraft !== false) {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid draft flag for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (pullRequest.state === "CLOSED") {
      return yield* new GitHubRequestError({
        message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} is closed`,
      })
    }
    if (pullRequest.state !== "OPEN" && pullRequest.state !== "MERGED") {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid pull request state for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (pullRequest.isDraft === false) {
      return
    }
    if (pullRequest.state === "MERGED") {
      return yield* new GitHubRequestError({
        message: `GitHub returned a merged draft pull request for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (client.mutation === undefined) {
      return yield* new GitHubRequestError({
        message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    const mutate = client.mutation
    const mutation = yield* githubRequest(
      `Failed to mark pull request ready for review for ${repository.owner}/${repository.name}:${headRefName}`,
      (signal) =>
        mutate(
          {
            markPullRequestReadyForReview: {
              __args: {
                input: { pullRequestId: pullRequest.id },
              },
              pullRequest: {
                isDraft: true,
              },
            },
          },
          signal,
        ),
    )
    const readyPullRequest = mutation.markPullRequestReadyForReview?.pullRequest
    if (readyPullRequest === null || readyPullRequest === undefined) {
      return yield* new GitHubRequestError({
        message: `GitHub did not return a pull request after marking ready for review for ${repository.owner}/${repository.name}:${headRefName}`,
      })
    }
    if (readyPullRequest.isDraft !== false) {
      return yield* new GitHubRequestError({
        message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} is still a draft`,
      })
    }
  }),
  mergePullRequest: Effect.fn("GitHubService.mergePullRequest")(
    function* (repository, headRefName) {
      const loadPullRequest = () =>
        githubQuery(
          `Failed to find pull request for ${repository.owner}/${repository.name}:${headRefName}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  pullRequests: {
                    __args: {
                      first: 1,
                      headRefName,
                      states: ["OPEN", "CLOSED", "MERGED"],
                    },
                    nodes: {
                      id: true,
                      state: true,
                      merged: true,
                      mergeable: true,
                      headRefOid: true,
                      statusCheckRollup: {
                        state: true,
                      },
                    },
                  },
                },
              },
              signal,
            ),
        )
      const result = yield* loadPullRequest()
      if (result.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      const pullRequest = result.repository.pullRequests.nodes?.[0]
      if (pullRequest === null || pullRequest === undefined) {
        return yield* new GitHubRequestError({
          message: `No pull request found for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (typeof pullRequest.id !== "string" || pullRequest.id.trim() === "") {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request id for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (pullRequest.merged !== true && pullRequest.merged !== false) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid merged flag for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (pullRequest.merged === true || pullRequest.state === "MERGED") {
        return { _tag: "merged" } as const
      }
      if (pullRequest.state === "CLOSED") {
        return {
          _tag: "needs_human",
          reason: "closed_unmerged",
          message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} was closed without merging`,
        } as const
      }
      if (pullRequest.state !== "OPEN") {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request state for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        typeof pullRequest.headRefOid !== "string" ||
        pullRequest.headRefOid.trim() === ""
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request head for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (pullRequest.statusCheckRollup === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub omitted the check rollup for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        pullRequest.statusCheckRollup !== null &&
        !isGitHubStatusCheckState(pullRequest.statusCheckRollup.state)
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid check rollup for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        pullRequest.statusCheckRollup !== null &&
        pullRequest.statusCheckRollup.state !== "SUCCESS"
      ) {
        return {
          _tag: "revalidation",
          reason: "checks_not_green",
          message: `Pull request checks are no longer successful for ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (
        pullRequest.mergeable !== "MERGEABLE" &&
        pullRequest.mergeable !== "CONFLICTING" &&
        pullRequest.mergeable !== "UNKNOWN"
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned invalid mergeability for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (pullRequest.mergeable !== "MERGEABLE") {
        return {
          _tag: "revalidation",
          reason: "mergeability_changed",
          message: `Pull request mergeability is ${pullRequest.mergeable.toLowerCase()} for ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (client.mutation === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      const mutate = client.mutation
      const mutationResult = yield* Effect.result(
        githubRequest(
          `Failed to merge pull request for ${repository.owner}/${repository.name}:${headRefName}`,
          (signal) =>
            mutate(
              {
                mergePullRequest: {
                  __args: {
                    input: {
                      pullRequestId: pullRequest.id,
                      expectedHeadOid: pullRequest.headRefOid,
                      mergeMethod: "SQUASH",
                    },
                  },
                  pullRequest: {
                    merged: true,
                    state: true,
                    headRefOid: true,
                    mergeable: true,
                    statusCheckRollup: {
                      state: true,
                    },
                  },
                },
              },
              signal,
            ),
        ),
      )
      let mergedPullRequest: GitHubMergePullRequestSnapshot | null | undefined
      if (Result.isFailure(mutationResult)) {
        if (
          !(mutationResult.failure.cause instanceof GenqlError) ||
          !isMergeGraphqlRejection(mutationResult.failure.cause)
        ) {
          return yield* mutationResult.failure
        }
        const refreshed = yield* loadPullRequest()
        if (refreshed.repository === null) {
          return yield* new GitHubApiRepositoryUnavailableError(repository)
        }
        mergedPullRequest = refreshed.repository.pullRequests.nodes?.[0]
      } else {
        mergedPullRequest = mutationResult.success.mergePullRequest?.pullRequest
      }
      if (mergedPullRequest === null || mergedPullRequest === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub did not return a pull request after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        mergedPullRequest.merged !== true &&
        mergedPullRequest.merged !== false
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid merged flag after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        mergedPullRequest.merged === true ||
        mergedPullRequest.state === "MERGED"
      ) {
        return { _tag: "merged" } as const
      }
      if (mergedPullRequest.state === "CLOSED") {
        return {
          _tag: "needs_human",
          reason: "closed_unmerged",
          message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} was concurrently closed without merging`,
        } as const
      }
      if (mergedPullRequest.state !== "OPEN") {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request state after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        typeof mergedPullRequest.headRefOid !== "string" ||
        mergedPullRequest.headRefOid.trim() === ""
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid pull request head after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (mergedPullRequest.headRefOid !== pullRequest.headRefOid) {
        return {
          _tag: "revalidation",
          reason: "head_changed",
          message: `Pull request head changed while merging ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (mergedPullRequest.statusCheckRollup === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub omitted the check rollup after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        mergedPullRequest.statusCheckRollup !== null &&
        !isGitHubStatusCheckState(mergedPullRequest.statusCheckRollup.state)
      ) {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid check rollup after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        mergedPullRequest.statusCheckRollup !== null &&
        mergedPullRequest.statusCheckRollup.state !== "SUCCESS"
      ) {
        return {
          _tag: "revalidation",
          reason: "checks_not_green",
          message: `Pull request checks changed while merging ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (
        mergedPullRequest.mergeable === "CONFLICTING" ||
        mergedPullRequest.mergeable === "UNKNOWN"
      ) {
        return {
          _tag: "revalidation",
          reason: "mergeability_changed",
          message: `Pull request mergeability changed while merging ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (mergedPullRequest.mergeable !== "MERGEABLE") {
        return yield* new GitHubRequestError({
          message: `GitHub returned invalid mergeability after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      return {
        _tag: "needs_human",
        reason: "merge_rejected",
        message: `GitHub rejected the unchanged, open, green, mergeable pull request for ${repository.owner}/${repository.name}:${headRefName}`,
      } satisfies MergePullRequestResult
    },
  ),
  rerunWorkflowRun: Effect.fn("GitHubService.rerunWorkflowRun")(
    function* (repository, workflowRunId) {
      if (
        !Number.isSafeInteger(workflowRunId) ||
        workflowRunId <= 0 ||
        rerunWorkflowRunImpl === undefined
      ) {
        return yield* new GitHubRequestError({
          message:
            rerunWorkflowRunImpl === undefined
              ? `Workflow rerun is not configured for ${repository.owner}/${repository.name}`
              : `Invalid workflow run id ${String(workflowRunId)} for ${repository.owner}/${repository.name}`,
        })
      }
      yield* githubRequest(
        `Failed to rerun workflow run ${workflowRunId} for ${repository.owner}/${repository.name}`,
        (signal) => rerunWorkflowRunImpl(repository, workflowRunId, signal),
      )
    },
  ),
  ensureIssueCompletedWithSummary: Effect.fn(
    "GitHubService.ensureIssueCompletedWithSummary",
  )(function* (repository, issueNumber, workItemId, summaryMarkdown) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return yield* new GitHubRequestError({
        message: `Invalid Issue number for ${repository.owner}/${repository.name}: ${String(issueNumber)}`,
      })
    }
    if (typeof workItemId !== "string" || workItemId.trim() === "") {
      return yield* new GitHubRequestError({
        message: `Invalid Work Item id for ${repository.owner}/${repository.name}#${issueNumber}`,
      })
    }
    if (typeof summaryMarkdown !== "string" || summaryMarkdown.trim() === "") {
      return yield* new GitHubRequestError({
        message: `Empty completion summary for ${repository.owner}/${repository.name}#${issueNumber}`,
      })
    }

    const marker = workItemCompletionMarker(workItemId)
    const issueRef = `${repository.owner}/${repository.name}#${issueNumber}`

    const issueResult = yield* githubQuery(
      `Failed to load Issue ${issueRef}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              issue: {
                __args: { number: issueNumber },
                id: true,
                state: true,
              },
            },
          },
          signal,
        ),
    )
    if (issueResult.repository === null) {
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    }
    const issue = issueResult.repository.issue
    if (issue === null || issue === undefined) {
      return yield* new GitHubRequestError({
        message: `No Issue found for ${issueRef}`,
      })
    }
    if (typeof issue.id !== "string" || issue.id.trim() === "") {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid Issue id for ${issueRef}`,
      })
    }
    if (issue.state !== "OPEN" && issue.state !== "CLOSED") {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid Issue state for ${issueRef}`,
      })
    }

    let hasMarkedComment = false
    let commentsAfter: string | null = null
    while (true) {
      const commentsResult = yield* githubQuery(
        `Failed to list comments for Issue ${issueRef}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                issue: {
                  __args: { number: issueNumber },
                  comments: {
                    __args: {
                      first: PAGE_SIZE,
                      after: commentsAfter,
                    },
                    nodes: {
                      body: true,
                    },
                    pageInfo: {
                      endCursor: true,
                      hasNextPage: true,
                    },
                  },
                },
              },
            },
            signal,
          ),
      )
      if (commentsResult.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      const commentsIssue = commentsResult.repository.issue
      if (commentsIssue === null || commentsIssue === undefined) {
        return yield* new GitHubRequestError({
          message: `No Issue found for ${issueRef}`,
        })
      }
      for (const comment of commentsIssue.comments.nodes ?? []) {
        if (comment !== null && typeof comment.body === "string") {
          if (comment.body.includes(marker)) {
            hasMarkedComment = true
            break
          }
        }
      }
      if (hasMarkedComment) {
        break
      }
      if (!commentsIssue.comments.pageInfo.hasNextPage) {
        break
      }
      const endCursor = commentsIssue.comments.pageInfo.endCursor
      if (typeof endCursor !== "string" || endCursor.trim() === "") {
        return yield* new GitHubRequestError({
          message: `GitHub returned an invalid comments page cursor for ${issueRef}`,
        })
      }
      commentsAfter = endCursor
    }

    if (!hasMarkedComment) {
      if (client.mutation === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub GraphQL client does not support mutations for ${issueRef}`,
        })
      }
      const mutate = client.mutation
      const body = `${summaryMarkdown.trimEnd()}\n\n${marker}`
      const addResult = yield* githubRequest(
        `Failed to post completion summary on Issue ${issueRef}`,
        (signal) =>
          mutate(
            {
              addComment: {
                __args: {
                  input: {
                    subjectId: issue.id,
                    body,
                  },
                },
                commentEdge: {
                  node: {
                    body: true,
                  },
                },
              },
            },
            signal,
          ),
      )
      const postedBody = addResult.addComment?.commentEdge?.node?.body
      if (typeof postedBody !== "string" || !postedBody.includes(marker)) {
        return yield* new GitHubRequestError({
          message: `GitHub did not return a marked completion comment for ${issueRef}`,
        })
      }
    }

    if (issue.state === "CLOSED") {
      return
    }

    if (client.mutation === undefined) {
      return yield* new GitHubRequestError({
        message: `GitHub GraphQL client does not support mutations for ${issueRef}`,
      })
    }
    const mutate = client.mutation
    const closeResult = yield* githubRequest(
      `Failed to close Issue ${issueRef}`,
      (signal) =>
        mutate(
          {
            closeIssue: {
              __args: {
                input: {
                  issueId: issue.id,
                  stateReason: "COMPLETED",
                },
              },
              issue: {
                state: true,
              },
            },
          },
          signal,
        ),
    )
    const closedIssue = closeResult.closeIssue?.issue
    if (closedIssue === null || closedIssue === undefined) {
      return yield* new GitHubRequestError({
        message: `GitHub did not return an Issue after closing ${issueRef}`,
      })
    }
    if (closedIssue.state !== "CLOSED") {
      return yield* new GitHubRequestError({
        message: `Issue ${issueRef} is still open after close`,
      })
    }
  }),
  listReadyIssues: Effect.fn("GitHubService.listReadyIssues")(
    function* (repository) {
      const issues: InternalReadyLabeledIssue[] = []
      const subIssuePositions = new Map<string, number>()
      const repositoryName = `${repository.owner}/${repository.name}`
      let after: string | null = null

      while (true) {
        const result = yield* githubQuery(
          `Failed to list Ready-labeled Issues for ${repository.owner}/${repository.name}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  issues: {
                    __args: {
                      first: PAGE_SIZE,
                      after,
                      labels: [READY_FOR_AGENT_LABEL],
                    },
                    nodes: {
                      number: true,
                      title: true,
                      body: true,
                      url: true,
                      createdAt: true,
                      state: true,
                      author: {
                        login: true,
                      },
                      parent: {
                        number: true,
                        url: true,
                        state: true,
                        repository: { nameWithOwner: true },
                        parent: {
                          number: true,
                          url: true,
                          repository: { nameWithOwner: true },
                        },
                      },
                      subIssuesSummary: { total: true },
                      subIssues: {
                        __args: { first: PAGE_SIZE },
                        nodes: {
                          number: true,
                          url: true,
                          repository: { nameWithOwner: true },
                          subIssuesSummary: { total: true },
                        },
                        pageInfo: { endCursor: true, hasNextPage: true },
                      },
                      blockedBy: {
                        __args: { first: PAGE_SIZE },
                        nodes: { number: true, url: true, state: true },
                        pageInfo: { endCursor: true, hasNextPage: true },
                      },
                      closedByPullRequestsReferences: {
                        __args: {
                          first: PAGE_SIZE,
                          includeClosedPrs: true,
                        },
                        nodes: {
                          number: true,
                          state: true,
                          merged: true,
                          isDraft: true,
                          repository: { nameWithOwner: true },
                        },
                        pageInfo: { endCursor: true, hasNextPage: true },
                      },
                    },
                    pageInfo: {
                      endCursor: true,
                      hasNextPage: true,
                    },
                  },
                },
              },
              signal,
            ),
        )

        if (result.repository === null) {
          return yield* new GitHubApiRepositoryUnavailableError(repository)
        }

        const issueNodes = (result.repository.issues.nodes ??
          []) as readonly (GitHubApiIssue | null)[]
        for (const issueNode of issueNodes) {
          if (issueNode === null) continue

          const mappedIssue = yield* Effect.try({
            try: () => toReadyLabeledIssue(issueNode, repositoryName),
            catch: (cause) =>
              new GitHubRequestError({
                message: `GitHub returned invalid Issue data for ${repository.owner}/${repository.name}`,
                cause,
              }),
          })
          const blockedBy = [...mappedIssue.blockedBy]
          const closingPullRequests = [...mappedIssue.closingPullRequests]
          let blockedByPage = issueNode.blockedBy.pageInfo
          let closingPullRequestsPage = issueNode.closedByPullRequestsReferences
            ?.pageInfo ?? {
            endCursor: null,
            hasNextPage: false,
          }
          let hasUnsupportedDescendants = mappedIssue.hasUnsupportedDescendants
          let subIssuesPage = issueNode.subIssues.pageInfo
          let subIssueOffset = yield* Effect.try({
            try: () =>
              recordSubIssuePositions(
                issueNode.subIssues,
                subIssuePositions,
                0,
              ),
            catch: (cause) =>
              new GitHubRequestError({
                message: `GitHub returned invalid sub-issue data for ${repositoryName}#${mappedIssue.number}`,
                cause,
              }),
          })

          while (blockedByPage.hasNextPage) {
            if (blockedByPage.endCursor === null) {
              return yield* new GitHubRequestError({
                message: `GitHub omitted the dependency page cursor for ${repository.owner}/${repository.name}#${mappedIssue.number}`,
              })
            }

            const dependencyResult = yield* githubQuery(
              `Failed to list dependencies for ${repository.owner}/${repository.name}#${mappedIssue.number}`,
              (signal) =>
                client.query(
                  {
                    repository: {
                      __args: repository,
                      issue: {
                        __args: { number: mappedIssue.number },
                        blockedBy: {
                          __args: {
                            first: PAGE_SIZE,
                            after: blockedByPage.endCursor,
                          },
                          nodes: { number: true, url: true, state: true },
                          pageInfo: { endCursor: true, hasNextPage: true },
                        },
                      },
                    },
                  },
                  signal,
                ),
            )
            if (dependencyResult.repository === null) {
              return yield* new GitHubApiRepositoryUnavailableError(repository)
            }
            if (dependencyResult.repository.issue === null) {
              return yield* new GitHubRequestError({
                message: `GitHub could not find Issue ${repository.owner}/${repository.name}#${mappedIssue.number} while listing dependencies`,
              })
            }

            const connection = dependencyResult.repository.issue
              .blockedBy as GitHubApiIssueConnection
            const pageDependencies = yield* Effect.try({
              try: () => mapBlockedByPage(connection),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `GitHub returned invalid dependency data for ${repository.owner}/${repository.name}#${mappedIssue.number}`,
                  cause,
                }),
            })
            blockedBy.push(...pageDependencies)
            blockedByPage = connection.pageInfo
          }

          while (closingPullRequestsPage.hasNextPage) {
            if (closingPullRequestsPage.endCursor === null) {
              return yield* new GitHubRequestError({
                message: `GitHub omitted the closing pull request page cursor for ${repositoryName}#${mappedIssue.number}`,
              })
            }

            const pullRequestResult = yield* githubQuery(
              `Failed to list closing pull requests for ${repositoryName}#${mappedIssue.number}`,
              (signal) =>
                client.query(
                  {
                    repository: {
                      __args: repository,
                      issue: {
                        __args: { number: mappedIssue.number },
                        closedByPullRequestsReferences: {
                          __args: {
                            first: PAGE_SIZE,
                            after: closingPullRequestsPage.endCursor,
                            includeClosedPrs: true,
                          },
                          nodes: {
                            number: true,
                            state: true,
                            merged: true,
                            isDraft: true,
                            repository: { nameWithOwner: true },
                          },
                          pageInfo: { endCursor: true, hasNextPage: true },
                        },
                      },
                    },
                  },
                  signal,
                ),
            )
            if (pullRequestResult.repository === null) {
              return yield* new GitHubApiRepositoryUnavailableError(repository)
            }
            if (pullRequestResult.repository.issue === null) {
              return yield* new GitHubRequestError({
                message: `GitHub could not find Issue ${repositoryName}#${mappedIssue.number} while listing closing pull requests`,
              })
            }

            const connection = pullRequestResult.repository.issue
              .closedByPullRequestsReferences as GitHubApiPullRequestConnection
            closingPullRequests.push(
              ...(yield* Effect.try({
                try: () => mapClosingPullRequestPage(connection),
                catch: (cause) =>
                  new GitHubRequestError({
                    message: `GitHub returned invalid closing pull request data for ${repositoryName}#${mappedIssue.number}`,
                    cause,
                  }),
              })),
            )
            closingPullRequestsPage = connection.pageInfo
          }

          while (subIssuesPage.hasNextPage) {
            if (subIssuesPage.endCursor === null) {
              return yield* new GitHubRequestError({
                message: `GitHub omitted the sub-issue page cursor for ${repositoryName}#${mappedIssue.number}`,
              })
            }

            const subIssueResult = yield* githubQuery(
              `Failed to list sub-issues for ${repositoryName}#${mappedIssue.number}`,
              (signal) =>
                client.query(
                  {
                    repository: {
                      __args: repository,
                      issue: {
                        __args: { number: mappedIssue.number },
                        subIssues: {
                          __args: {
                            first: PAGE_SIZE,
                            after: subIssuesPage.endCursor,
                          },
                          nodes: {
                            number: true,
                            url: true,
                            repository: { nameWithOwner: true },
                            subIssuesSummary: { total: true },
                          },
                          pageInfo: { endCursor: true, hasNextPage: true },
                        },
                      },
                    },
                  },
                  signal,
                ),
            )
            if (subIssueResult.repository === null) {
              return yield* new GitHubApiRepositoryUnavailableError(repository)
            }
            if (subIssueResult.repository.issue === null) {
              hasUnsupportedDescendants = true
              break
            }

            const connection = subIssueResult.repository.issue
              .subIssues as GitHubApiSubIssueConnection
            hasUnsupportedDescendants =
              hasUnsupportedDescendants ||
              (yield* Effect.try({
                try: () =>
                  pageHasUnsupportedSubIssue(connection, repositoryName),
                catch: (cause) =>
                  new GitHubRequestError({
                    message: `GitHub returned invalid sub-issue data for ${repositoryName}#${mappedIssue.number}`,
                    cause,
                  }),
              }))
            subIssueOffset = yield* Effect.try({
              try: () =>
                recordSubIssuePositions(
                  connection,
                  subIssuePositions,
                  subIssueOffset,
                ),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `GitHub returned invalid sub-issue data for ${repositoryName}#${mappedIssue.number}`,
                  cause,
                }),
            })
            subIssuesPage = connection.pageInfo
          }

          issues.push({
            ...mappedIssue,
            hasUnsupportedDescendants,
            blockedBy: sortDependencies(blockedBy),
            closingPullRequests: [
              ...new Map(
                closingPullRequests.map((pullRequest) => [
                  `${pullRequest.repository.toLowerCase()}#${pullRequest.number}`,
                  pullRequest,
                ]),
              ).values(),
            ].sort(
              (left, right) =>
                left.repository.localeCompare(right.repository) ||
                left.number - right.number,
            ),
          })
        }

        const { endCursor, hasNextPage } = result.repository.issues.pageInfo
        if (!hasNextPage) {
          break
        }
        if (endCursor === null) {
          return yield* new GitHubRequestError({
            message: `GitHub omitted the next page cursor for ${repository.owner}/${repository.name}`,
          })
        }
        after = endCursor
      }

      const issueUrlKey = (url: string) => url.toLowerCase()
      const readyIssueUrls = new Set(
        issues.map((issue) => issueUrlKey(issue.url)),
      )
      const hierarchy = (issue: InternalReadyLabeledIssue) => {
        if (issue.parent === null) {
          return { rootUrl: issueUrlKey(issue.url), unsupported: false }
        }
        if (
          issue.parent.repository.toLowerCase() !== repositoryName.toLowerCase()
        ) {
          return { rootUrl: issueUrlKey(issue.parent.url), unsupported: true }
        }
        if (issue.parent.parent === null) {
          return { rootUrl: issueUrlKey(issue.parent.url), unsupported: false }
        }
        return {
          rootUrl: issueUrlKey(issue.parent.parent.url),
          unsupported: true,
        }
      }
      const invalidRoots = new Set<string>()
      for (const issue of issues) {
        const issueHierarchy = hierarchy(issue)
        if (issueHierarchy.unsupported || issue.hasUnsupportedDescendants) {
          invalidRoots.add(issueHierarchy.rootUrl)
        }
      }

      return issues
        .map((issue): ReadyLabeledIssue => {
          const issueHierarchy = hierarchy(issue)
          return {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            createdAt: issue.createdAt,
            state: issue.state,
            author: issue.author,
            hasChildren: issue.hasChildren,
            parentPosition:
              issue.parent === null
                ? null
                : (subIssuePositions.get(issueUrlKey(issue.url)) ?? null),
            parent:
              issue.parent === null
                ? null
                : {
                    number: issue.parent.number,
                    url: issue.parent.url,
                    state: issue.parent.state,
                    isReadyLabeled: readyIssueUrls.has(
                      issueUrlKey(issue.parent.url),
                    ),
                  },
            hierarchySupported:
              !issueHierarchy.unsupported &&
              !invalidRoots.has(issueHierarchy.rootUrl),
            blockedBy: issue.blockedBy,
            closingPullRequests: issue.closingPullRequests,
          }
        })
        .sort((left, right) => left.number - right.number)
    },
  ),
})

const toGitHubApiRepository = (
  repository: GitHubRepository,
): GitHubApiRepository => {
  const separator = repository.projectPath.indexOf("/")
  if (separator <= 0 || separator === repository.projectPath.length - 1) {
    return { owner: repository.projectPath, name: "" }
  }
  return {
    owner: repository.projectPath.slice(0, separator),
    name: repository.projectPath.slice(separator + 1),
  }
}

const adaptRepository =
  <Args extends readonly unknown[], A, E, R>(
    method: (
      repository: GitHubApiRepository,
      ...args: Args
    ) => Effect.Effect<A, E | GitHubApiRepositoryUnavailableError, R>,
  ) =>
  (
    repository: GitHubRepository,
    ...args: Args
  ): Effect.Effect<A, E | GitHubRepositoryUnavailableError, R> =>
    method(toGitHubApiRepository(repository), ...args).pipe(
      Effect.catchTag("GitHubApiRepositoryUnavailableError", () =>
        Effect.fail(new GitHubRepositoryUnavailableError(repository)),
      ),
    )

export const makeGitHubService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
  rerunWorkflowRunImpl?: RerunWorkflowRun,
  observeAutomatedReviewEvidenceImpl?: ObserveAutomatedReviewEvidence,
): GitHubServiceShape => {
  const service = makeGitHubApiService(
    client,
    listTerminalChecksForCommit,
    loadPrStatusCheckDiagnostics,
    rerunWorkflowRunImpl,
    observeAutomatedReviewEvidenceImpl,
  )
  return {
    getAuthenticatedUserLogin: adaptRepository(
      service.getAuthenticatedUserLogin,
    ),
    listReadyIssues: adaptRepository(service.listReadyIssues),
    getPullRequestCheckStatus: adaptRepository(
      service.getPullRequestCheckStatus,
    ),
    getPrStatusCheckDiagnostics: adaptRepository(
      service.getPrStatusCheckDiagnostics,
    ),
    observeAutomatedReviewEvidence: adaptRepository(
      service.observeAutomatedReviewEvidence,
    ),
    getPullRequestLifecycleStatus: adaptRepository(
      service.getPullRequestLifecycleStatus,
    ),
    getOpenPullRequestNumber: adaptRepository(service.getOpenPullRequestNumber),
    findOpenPullRequestNumber: adaptRepository(
      service.findOpenPullRequestNumber,
    ),
    closeOpenPullRequestsAndDeleteBranch: adaptRepository(
      service.closeOpenPullRequestsAndDeleteBranch,
    ),
    countOpenNonDraftPullRequests: adaptRepository(
      service.countOpenNonDraftPullRequests,
    ),
    createDraftPullRequest: adaptRepository(service.createDraftPullRequest),
    updateOpenDraftPullRequestCopy: adaptRepository(
      service.updateOpenDraftPullRequestCopy,
    ),
    markPullRequestReadyForReview: adaptRepository(
      service.markPullRequestReadyForReview,
    ),
    mergePullRequest: adaptRepository(service.mergePullRequest),
    rerunWorkflowRun: adaptRepository(service.rerunWorkflowRun),
    ensureIssueCompletedWithSummary: adaptRepository(
      service.ensureIssueCompletedWithSummary,
    ),
  }
}

const githubRestHeaders = (token: string) =>
  ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  }) as const

const readGitHubJson = async <A>(
  response: Response,
  message: string,
): Promise<A> => {
  if (!response.ok) {
    throw new GitHubHttpError({
      statusCode: response.status,
      headers: response.headers,
      message: `${message}: ${response.statusText}: ${await response.text()}`,
    })
  }
  return (await response.json()) as A
}

const listTerminalChecksViaCheckRuns = async (
  token: string,
  repository: { owner: string; name: string },
  headSha: string,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<readonly TerminalPrStatusCheck[]> => {
  const checks: TerminalPrStatusCheck[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(headSha)}/check-runs`,
    )
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    url.searchParams.set("filter", "latest")
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    const body = await readGitHubJson<{
      readonly check_runs?: readonly GitHubRestCheckRun[] | null
    }>(
      response,
      `Failed to list check runs for ${repository.owner}/${repository.name}@${headSha}`,
    )
    const runs = body.check_runs ?? []
    for (const run of runs) {
      const mapped = mapRestCheckExecution(run)
      if (mapped !== null) {
        checks.push(mapped)
      }
    }
    if (runs.length < PAGE_SIZE) {
      break
    }
  }
  return checks
}

const listTerminalChecksViaActions = async (
  token: string,
  repository: { owner: string; name: string },
  headSha: string,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<readonly TerminalPrStatusCheck[]> => {
  const checks: TerminalPrStatusCheck[] = []
  const runs: { readonly id: number; readonly name: string | null }[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs`,
    )
    url.searchParams.set("head_sha", headSha)
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    const body = await readGitHubJson<{
      readonly workflow_runs?: readonly GitHubRestWorkflowRun[] | null
    }>(
      response,
      `Failed to list workflow runs for ${repository.owner}/${repository.name}@${headSha}`,
    )
    const pageRuns = body.workflow_runs ?? []
    for (const run of pageRuns) {
      if (typeof run.id === "number" && Number.isSafeInteger(run.id)) {
        runs.push({
          id: run.id,
          name:
            typeof run.name === "string" && run.name.trim() !== ""
              ? run.name
              : null,
        })
      }
    }
    if (pageRuns.length < PAGE_SIZE) {
      break
    }
  }
  for (const run of runs) {
    for (let page = 1; ; page += 1) {
      const url = new URL(
        `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs/${run.id}/jobs`,
      )
      url.searchParams.set("per_page", String(PAGE_SIZE))
      url.searchParams.set("page", String(page))
      const response = await fetchImpl(url, {
        headers: githubRestHeaders(token),
        signal,
      })
      const body = await readGitHubJson<{
        readonly jobs?: readonly GitHubRestJob[] | null
      }>(
        response,
        `Failed to list workflow jobs for ${repository.owner}/${repository.name} run ${run.id}`,
      )
      const jobs = body.jobs ?? []
      for (const job of jobs) {
        const mapped = mapRestCheckExecution(job)
        if (mapped === null) {
          continue
        }
        checks.push(
          run.name === null
            ? mapped
            : {
                ...mapped,
                name: `${run.name}/${mapped.name}`,
              },
        )
      }
      if (jobs.length < PAGE_SIZE) {
        break
      }
    }
  }
  return checks
}

const makeRerunWorkflowRun =
  (token: string, fetchImpl: GitHubFetch): RerunWorkflowRun =>
  async (repository, workflowRunId, signal) => {
    const response = await fetchImpl(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs/${workflowRunId}/rerun`,
      {
        method: "POST",
        headers: githubRestHeaders(token),
        signal,
      },
    )
    if (!response.ok) {
      throw new GitHubHttpError({
        statusCode: response.status,
        headers: response.headers,
        message: `Failed to rerun workflow run ${workflowRunId} for ${repository.owner}/${repository.name}: ${response.statusText}: ${await response.text()}`,
      })
    }
  }

const loginFromAuthor = (author: unknown): string | null => {
  if (author === null || author === undefined || typeof author !== "object") {
    return null
  }
  const login = (author as GitHubRestLoginAuthor).login
  if (typeof login !== "string" || login.trim() === "") {
    return null
  }
  return login.trim()
}

const listAuthorLoginsFromRestCollection = async (
  token: string,
  urlBase: string,
  fetchImpl: GitHubFetch,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<readonly string[]> => {
  const logins: string[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(urlBase)
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    const items = await readGitHubJson<
      readonly { readonly user?: unknown; readonly author?: unknown }[]
    >(response, errorMessage)
    for (const item of items) {
      const login = loginFromAuthor(item.user) ?? loginFromAuthor(item.author)
      if (login !== null) {
        logins.push(login)
      }
    }
    if (items.length < PAGE_SIZE) {
      break
    }
  }
  return logins
}

const fetchActionsJobExecution = async (
  token: string,
  repository: { owner: string; name: string },
  jobId: number,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<{
  readonly conclusion: unknown
  readonly steps: readonly {
    readonly status?: unknown
    readonly conclusion?: unknown
  }[]
}> => {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/jobs/${jobId}`,
    {
      headers: githubRestHeaders(token),
      signal,
    },
  )
  const job = await readGitHubJson<{
    readonly conclusion?: unknown
    readonly steps?:
      | readonly {
          readonly status?: unknown
          readonly conclusion?: unknown
        }[]
      | null
  }>(
    response,
    `Failed to load Actions job ${jobId} for ${repository.owner}/${repository.name}`,
  )
  return {
    conclusion: job.conclusion,
    steps: job.steps ?? [],
  }
}

const resolveOpenPullRequestNumberForEvidence = async (
  token: string,
  repository: { owner: string; name: string },
  headRefName: string,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<number | null> => {
  const url = new URL(
    `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/pulls`,
  )
  url.searchParams.set("state", "open")
  url.searchParams.set("head", `${repository.owner}:${headRefName}`)
  url.searchParams.set("per_page", "1")
  const response = await fetchImpl(url, {
    headers: githubRestHeaders(token),
    signal,
  })
  const pulls = await readGitHubJson<readonly { readonly number?: unknown }[]>(
    response,
    `Failed to resolve open pull request for ${repository.owner}/${repository.name}:${headRefName}`,
  )
  const number = pulls[0]?.number
  if (
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
  ) {
    return number
  }
  return null
}

const makeObserveAutomatedReviewEvidence =
  (token: string, fetchImpl: GitHubFetch): ObserveAutomatedReviewEvidence =>
  (repository, headRefName, checks) =>
    Effect.gen(function* () {
      const pullNumber = yield* githubRequest(
        `Failed to resolve open pull request for automated review evidence on ${repository.owner}/${repository.name}:${headRefName}`,
        (signal) =>
          resolveOpenPullRequestNumberForEvidence(
            token,
            repository,
            headRefName,
            fetchImpl,
            signal,
          ),
      )
      if (pullNumber === null) {
        return {
          _tag: "ambiguous" as const,
          reason: `No open pull request found for ${repository.owner}/${repository.name}:${headRefName}`,
        }
      }

      const issueComments = yield* githubRequest(
        `Failed to list issue comments for automated review evidence on ${repository.owner}/${repository.name}#${pullNumber}`,
        (signal) =>
          listAuthorLoginsFromRestCollection(
            token,
            `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/issues/${pullNumber}/comments`,
            fetchImpl,
            `Failed to list issue comments for ${repository.owner}/${repository.name}#${pullNumber}`,
            signal,
          ),
      )
      for (const login of issueComments) {
        if (isRecognizedAutomatedReviewerLogin(login)) {
          return {
            _tag: "positive" as const,
            kind: "review_comment" as const,
            detail: `Issue comment from ${login}`,
          }
        }
      }

      const reviewComments = yield* githubRequest(
        `Failed to list review comments for automated review evidence on ${repository.owner}/${repository.name}#${pullNumber}`,
        (signal) =>
          listAuthorLoginsFromRestCollection(
            token,
            `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/pulls/${pullNumber}/comments`,
            fetchImpl,
            `Failed to list review comments for ${repository.owner}/${repository.name}#${pullNumber}`,
            signal,
          ),
      )
      for (const login of reviewComments) {
        if (isRecognizedAutomatedReviewerLogin(login)) {
          return {
            _tag: "positive" as const,
            kind: "review_comment" as const,
            detail: `Review comment from ${login}`,
          }
        }
      }

      const reviews = yield* githubRequest(
        `Failed to list pull request reviews for automated review evidence on ${repository.owner}/${repository.name}#${pullNumber}`,
        (signal) =>
          listAuthorLoginsFromRestCollection(
            token,
            `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/pulls/${pullNumber}/reviews`,
            fetchImpl,
            `Failed to list pull request reviews for ${repository.owner}/${repository.name}#${pullNumber}`,
            signal,
          ),
      )
      for (const login of reviews) {
        if (isRecognizedAutomatedReviewerLogin(login)) {
          return {
            _tag: "positive" as const,
            kind: "pull_request_review" as const,
            detail: `Pull request review from ${login}`,
          }
        }
      }

      for (const check of checks) {
        if (!isRecognizedAutomatedReviewerName(check.name)) {
          continue
        }
        const { source, actionsJobId } = parseDiagnosticSource(check.externalId)
        if (source !== "actions-job" || actionsJobId === null) {
          return {
            _tag: "ambiguous" as const,
            reason: `Recognized automated reviewer check ${check.name} (${check.externalId}) has no inspectable Actions job steps`,
          }
        }
        const jobResult = yield* githubRequest(
          `Failed to load Actions job for automated review evidence on ${repository.owner}/${repository.name}`,
          (signal) =>
            fetchActionsJobExecution(
              token,
              repository,
              actionsJobId,
              fetchImpl,
              signal,
            ),
        ).pipe(Effect.result)
        if (Result.isFailure(jobResult)) {
          if (isGitHubThrottledError(jobResult.failure)) {
            return yield* jobResult.failure
          }
          return {
            _tag: "ambiguous" as const,
            reason: `Could not load Actions job steps for recognized reviewer ${check.name}: ${jobResult.failure.message}`,
          }
        }
        const stepInspection = inspectReviewerJobSteps(jobResult.success)
        if (stepInspection._tag === "executed") {
          return {
            _tag: "positive" as const,
            kind: "executed_reviewer_job" as const,
            detail: `Executed recognized reviewer job ${check.name} (${check.externalId})`,
          }
        }
        if (stepInspection._tag === "steps_unavailable") {
          return {
            _tag: "ambiguous" as const,
            reason: `Recognized automated reviewer job ${check.name} (${check.externalId}) concluded without inspectable steps`,
          }
        }
        // Skipped or all-skipped-step recognized reviewer: not positive evidence.
      }

      return {
        _tag: "none" as const,
        reason: GREEN_NO_REVIEW_EVIDENCE_REASON,
      }
    })

const listTerminalCommitStatuses = async (
  token: string,
  repository: { owner: string; name: string },
  headSha: string,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<readonly TerminalPrStatusCheck[]> => {
  const checks: TerminalPrStatusCheck[] = []
  const seenContexts = new Set<string>()
  for (let page = 1; ; page += 1) {
    const url = new URL(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(headSha)}/statuses`,
    )
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    const statuses = await readGitHubJson<readonly GitHubRestCommitStatus[]>(
      response,
      `Failed to list commit statuses for ${repository.owner}/${repository.name}@${headSha}`,
    )
    for (const status of statuses) {
      if (
        typeof status.context !== "string" ||
        seenContexts.has(status.context)
      ) {
        continue
      }
      seenContexts.add(status.context)
      const mapped = mapRestCommitStatus(status)
      if (mapped !== null) {
        checks.push(mapped)
      }
    }
    if (statuses.length < PAGE_SIZE) {
      break
    }
  }
  return checks
}

const makeListTerminalChecksForCommit =
  (token: string, fetchImpl: GitHubFetch): ListTerminalChecksForCommit =>
  async (repository, headSha, signal) => {
    let checkRuns: readonly TerminalPrStatusCheck[]
    try {
      checkRuns = await listTerminalChecksViaCheckRuns(
        token,
        repository,
        headSha,
        fetchImpl,
        signal,
      )
    } catch (cause) {
      // Fine-grained PATs cannot use the Checks API; Actions jobs still work.
      if (cause instanceof GitHubHttpError && cause.statusCode === 403) {
        const throttle = githubThrottleFromResponse({
          statusCode: cause.statusCode,
          headers: cause.headers,
          message: cause.message,
        })
        if (throttle !== undefined) throw throttle
        checkRuns = await listTerminalChecksViaActions(
          token,
          repository,
          headSha,
          fetchImpl,
          signal,
        )
      } else {
        throw cause
      }
    }
    const statuses = await listTerminalCommitStatuses(
      token,
      repository,
      headSha,
      fetchImpl,
      signal,
    )
    return uniqueTerminalChecks([...checkRuns, ...statuses])
  }

const fetchActionsJobDiagnostic = async (
  token: string,
  repository: { owner: string; name: string },
  jobId: number,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<{ readonly htmlUrl: string | null; readonly logText: string }> => {
  const jobResponse = await fetchImpl(
    `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/jobs/${jobId}`,
    {
      headers: githubRestHeaders(token),
      signal,
    },
  )
  const job = await readGitHubJson<{
    readonly html_url?: unknown
    readonly name?: unknown
  }>(
    jobResponse,
    `Failed to load Actions job ${jobId} for ${repository.owner}/${repository.name}`,
  )
  const htmlUrl =
    typeof job.html_url === "string" && job.html_url.trim() !== ""
      ? job.html_url
      : null

  const logsResponse = await fetchImpl(
    `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/jobs/${jobId}/logs`,
    {
      headers: githubRestHeaders(token),
      signal,
      redirect: "follow",
    },
  )
  if (!logsResponse.ok) {
    throw new GitHubHttpError({
      statusCode: logsResponse.status,
      headers: logsResponse.headers,
      message: `Failed to download Actions job logs for ${repository.owner}/${repository.name} job ${jobId}: ${logsResponse.statusText}: ${await logsResponse.text()}`,
    })
  }
  const logText = await logsResponse.text()
  return { htmlUrl, logText }
}

const toDiagnosticsFileError = (cause: PlatformError) =>
  new GitHubRequestError({
    message: `Failed to write PR Status Check diagnostic logs: ${cause.message}`,
    cause,
  })

const makeLoadPrStatusCheckDiagnostics =
  (
    token: string,
    fetchImpl: GitHubFetch,
    fs: FileSystem.FileSystem | undefined,
  ): LoadPrStatusCheckDiagnostics =>
  (repository, checks, options) =>
    Effect.gen(function* () {
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
      if (logDirectory !== undefined && fs !== undefined) {
        yield* fs
          .makeDirectory(logDirectory, { recursive: true })
          .pipe(Effect.mapError(toDiagnosticsFileError))
      }

      const diagnostics: PrStatusCheckDiagnostic[] = []
      for (const check of checks) {
        const { source, actionsJobId } = parseDiagnosticSource(check.externalId)
        if (source === "status") {
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source,
            htmlUrl: null,
            logFetch: {
              _tag: "unavailable",
              reason:
                "Commit status contexts do not expose Actions job logs; inspect the status target URL if present",
            },
          })
          continue
        }
        if (source !== "actions-job" || actionsJobId === null) {
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source,
            htmlUrl: null,
            logFetch: {
              _tag: "unavailable",
              reason: `No Actions job id available for external id ${check.externalId}`,
            },
          })
          continue
        }
        const fetched = yield* githubRequest(
          `Failed to load Actions job logs for ${repository.owner}/${repository.name}`,
          (signal) =>
            fetchActionsJobDiagnostic(
              token,
              repository,
              actionsJobId,
              fetchImpl,
              signal,
            ),
        ).pipe(Effect.result)

        if (Result.isFailure(fetched)) {
          if (isGitHubThrottledError(fetched.failure)) {
            return yield* fetched.failure
          }
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source,
            htmlUrl: null,
            logFetch: {
              _tag: "unavailable",
              reason: fetched.failure.message,
            },
          })
          continue
        }

        const { htmlUrl, logText } = fetched.success
        let localPath: string | null = null
        if (logDirectory !== undefined && fs !== undefined) {
          localPath = join(logDirectory, safeLogFileName(check.externalId))
          yield* fs
            .writeFileString(localPath, logText)
            .pipe(Effect.mapError(toDiagnosticsFileError))
        }
        diagnostics.push({
          externalId: check.externalId,
          name: check.name,
          source,
          htmlUrl,
          logFetch: {
            _tag: "ok",
            excerpt: boundLogExcerpt(logText, maxExcerptChars),
            localPath,
          },
        })
      }
      return diagnostics
    })

const makeGitHubGraphqlClient = (
  token: string,
  fetchImpl: GitHubFetch = fetch,
): GitHubGraphqlClient => {
  const client = (signal?: AbortSignal) =>
    createClient({
      url: GITHUB_GRAPHQL_URL,
      signal,
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await fetchImpl(input, init)
        if (!response.ok) {
          throw new GitHubHttpError({
            statusCode: response.status,
            headers: response.headers,
            message: `${response.statusText}: ${await response.text()}`,
          })
        }
        return response
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

  return {
    query: (request, signal) => client(signal).query(request),
    mutation: (request, signal) => client(signal).mutation(request),
  }
}

export const makeGitHubServiceFromToken = (
  token: string,
  fetchImpl: GitHubFetch = fetch,
  fs?: FileSystem.FileSystem,
  observeThrottle?: GitHubThrottleObserver,
): GitHubServiceShape => {
  const observingFetch: GitHubFetch = async (input, init) => {
    const response = await fetchImpl(input, init)
    if (response.ok) {
      const throttle = githubThrottleFromSuccessfulResponse({
        headers: response.headers,
      })
      if (throttle !== undefined) observeThrottle?.(throttle)
    }
    return response
  }
  return makeGitHubService(
    makeGitHubGraphqlClient(token, observingFetch),
    makeListTerminalChecksForCommit(token, observingFetch),
    makeLoadPrStatusCheckDiagnostics(token, observingFetch, fs),
    makeRerunWorkflowRun(token, observingFetch),
    makeObserveAutomatedReviewEvidence(token, observingFetch),
  )
}

/** Builds a live service and optionally observes successful final-quota use. */
export const makeGitHubServiceLive = (
  observeThrottle?: GitHubThrottleObserver,
): Layer.Layer<GitHubService, Config.ConfigError, FileSystem.FileSystem> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const token = yield* Config.redacted("GITHUB_TOKEN")
      const fs = yield* FileSystem.FileSystem
      return makeGitHubServiceFromToken(
        Redacted.value(token),
        fetch,
        fs,
        observeThrottle,
      )
    }),
  )

export const GitHubServiceLive = makeGitHubServiceLive()
