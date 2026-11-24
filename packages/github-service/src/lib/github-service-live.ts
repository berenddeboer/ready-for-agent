import { readFile } from "node:fs/promises"
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
  type CiGateCatalogEntry,
  type CiGateDefinitionObservation,
  type CiGateObservation,
  type CiGateObservedRun,
  type GitHubIssueReference,
  type GitHubIssueState,
  type GitHubPullRequestLifecycleState,
  type GitHubPullRequestReference,
  type MergePullRequestResult,
  type ObserveCiGateInput,
  type PrStatusCheckDiagnostic,
  type PrStatusCheckDiagnosticSource,
  type PrStatusCheckDiagnosticsOptions,
  type PrStatusCheckDiagnosticsRequest,
  type PublishedSpecFollowUps,
  type PullRequestCheckStatus,
  type ReadyLabeledIssue,
  SPEC_LABEL,
  type SpecFollowUpPublication,
  type TerminalPrStatusCheck,
  ciGateRunOrderKey,
  classifyCiGateObservedRun,
  compareCiGateRunOrder,
  extractErrorCode,
  formatSpecFollowUpComment,
  isDecisiveCiGateObservedRun,
  resolveSpecBaseline,
  specFindingsMarker,
  specFollowUpMarker,
} from "@ready-for-agent/forge-contract"
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
  classifyIncompleteAutomatedReviewOutput,
  extractWorkflowRunIdFromReviewComment,
  inspectReviewerJobSteps,
  isRecognizedAutomatedReviewerLogin,
  isRecognizedAutomatedReviewerName,
  workflowNameFromCheckName,
} from "./automated-review-evidence.js"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  type GitHubThrottledError,
  GitHubTlsTrustError,
  formatGitHubRepositoryUnavailableMessage,
  isGitHubThrottledError,
} from "./errors.js"
import {
  type GitHubCiRepairRun,
  GitHubService,
  type GitHubServiceShape,
} from "./github-service.js"
import {
  githubThrottleFromResponse,
  githubThrottleFromSuccessfulResponse,
} from "./github-throttle.js"
import {
  findTlsTrustCode,
  formatTlsTrustRemediation,
  githubApiHost,
} from "./tls-trust.js"
import {
  GITHUB_CI_GATE_KIND,
  type GitHubRepository,
  type GitHubSpecObservation,
  isGitHubUserAttachmentUrl,
} from "./types.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const GITHUB_API_URL = "https://api.github.com"
const GITHUB_USER_ATTACHMENTS_URL =
  "https://uploads.github.com/user-attachments/assets"

class GitHubApiRepositoryUnavailableError extends Schema.TaggedError<GitHubApiRepositoryUnavailableError>()(
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

const tlsTrustErrorFromCause = (
  message: string,
  cause: unknown,
): GitHubTlsTrustError | undefined => {
  const code = findTlsTrustCode(cause)
  if (code === undefined) {
    return undefined
  }
  const host = githubApiHost()
  return new GitHubTlsTrustError({
    message: formatTlsTrustRemediation({
      host,
      code,
      operationMessage: message,
    }),
    host,
    code,
    cause,
  })
}

const graphqlErrorField = (entry: unknown, field: string): unknown =>
  typeof entry === "object" && entry !== null
    ? Reflect.get(entry, field)
    : undefined

const isGraphqlRepositoryNotFound = (cause: unknown): cause is GenqlError => {
  if (!(cause instanceof GenqlError)) {
    return false
  }
  return cause.errors.some((entry) => {
    if (graphqlErrorField(entry, "type") !== "NOT_FOUND") {
      return false
    }
    const path = graphqlErrorField(entry, "path")
    return Array.isArray(path) && path.length === 1 && path[0] === "repository"
  })
}

const repositoryFromGraphqlNotFound = (
  cause: GenqlError,
): GitHubApiRepository => {
  for (const entry of cause.errors) {
    const message = graphqlErrorField(entry, "message")
    if (typeof message !== "string") {
      continue
    }
    const match = message.match(
      /Could not resolve to a Repository with the name '([^']+)'/,
    )
    const nameWithOwner = match?.[1]
    if (nameWithOwner === undefined) {
      continue
    }
    const separator = nameWithOwner.indexOf("/")
    if (separator <= 0 || separator === nameWithOwner.length - 1) {
      continue
    }
    return {
      owner: nameWithOwner.slice(0, separator),
      name: nameWithOwner.slice(separator + 1),
    }
  }
  return { owner: "", name: "" }
}

type GitHubRequestFailure =
  | GitHubRequestError
  | GitHubThrottledError
  | GitHubTlsTrustError
  | GitHubApiRepositoryUnavailableError

const githubRequest = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
  options?: { readonly includeHttpMessage: boolean },
): Effect.Effect<A, GitHubRequestFailure> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => {
      if (isGitHubThrottledError(cause)) return cause
      const tlsTrust = tlsTrustErrorFromCause(message, cause)
      if (tlsTrust !== undefined) return tlsTrust
      const throttle = githubThrottleFromResponse({
        statusCode: cause instanceof GitHubHttpError ? cause.statusCode : 0,
        headers:
          cause instanceof GitHubHttpError ? cause.headers : new Headers(),
        message: cause instanceof Error ? cause.message : "",
      })
      if (throttle !== undefined) return throttle
      if (isGraphqlRepositoryNotFound(cause)) {
        return new GitHubApiRepositoryUnavailableError(
          repositoryFromGraphqlNotFound(cause),
        )
      }
      const code = extractErrorCode(cause)
      return new GitHubRequestError({
        message:
          options?.includeHttpMessage === true &&
          cause instanceof GitHubHttpError
            ? cause.message
            : message,
        cause,
        ...(code !== undefined ? { code } : {}),
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
          code: "TIMEOUT",
          retryable: true,
        }),
      ),
    ),
  )

const githubQuery = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestFailure> =>
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

type MergeCheckRollupVerdict =
  | { readonly _tag: "ok" }
  | { readonly _tag: "invalid"; readonly message: string }
  | { readonly _tag: "missing_successful_checks" }
  | { readonly _tag: "checks_not_green" }

/**
 * Harness-initiated merge requires a non-empty successful aggregate, except
 * Always after the Check-Start Deadline may accept a null/`no_checks` rollup.
 * EXPECTED is never green.
 */
const classifyMergeCheckRollup = (
  rollup: { readonly state: unknown } | null | undefined,
  context: string,
  options?: { readonly acceptNoChecks?: boolean },
): MergeCheckRollupVerdict => {
  if (rollup === undefined) {
    return {
      _tag: "invalid",
      message: `GitHub omitted the check rollup for ${context}`,
    }
  }
  if (rollup === null) {
    return options?.acceptNoChecks === true
      ? { _tag: "ok" }
      : { _tag: "missing_successful_checks" }
  }
  if (rollup.state === "EXPECTED") {
    return { _tag: "missing_successful_checks" }
  }
  if (!isGitHubStatusCheckState(rollup.state)) {
    return {
      _tag: "invalid",
      message: `GitHub returned an invalid check rollup for ${context}`,
    }
  }
  if (rollup.state !== "SUCCESS") {
    return { _tag: "checks_not_green" }
  }
  return { _tag: "ok" }
}

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
  readonly html_url?: unknown
  readonly head_sha?: unknown
  readonly head_branch?: unknown
  readonly event?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly run_started_at?: unknown
  readonly run_attempt?: unknown
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
) => Effect.Effect<readonly PrStatusCheckDiagnostic[], GitHubRequestFailure>

/** Rerun an entire GitHub Actions workflow run. */
export type RerunWorkflowRun = (
  repository: { owner: string; name: string },
  workflowRunId: number,
  signal?: AbortSignal,
) => Promise<void>

/** List active GitHub Actions workflows as CI Gate catalog entries. */
export type ListCiGateCatalog = (
  repository: { owner: string; name: string },
  signal?: AbortSignal,
) => Promise<readonly CiGateCatalogEntry[]>

/** Observe selected CI Gate Definitions on the current default branch. */
export type ObserveCiGate = (
  repository: { owner: string; name: string },
  input: ObserveCiGateInput,
  signal?: AbortSignal,
) => Promise<CiGateObservation>

/** Upload file bytes as a GitHub user attachment and return the CDN URL. */
export type UploadUserAttachment = (
  repository: { owner: string; name: string },
  input: {
    readonly name: string
    readonly contentType: string
    readonly body: Uint8Array
  },
  signal?: AbortSignal,
) => Promise<string>

/** Observe automated-review evidence for a green Status Check Handoff. */
export type ObserveAutomatedReviewEvidence = (
  repository: { owner: string; name: string },
  headRefName: string,
  checks: readonly AutomatedReviewEvidenceCheck[],
  signal?: AbortSignal,
) => Effect.Effect<AutomatedReviewEvidenceObservation, GitHubRequestFailure>

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
    catch: (cause) => {
      const code = extractErrorCode(cause)
      return new GitHubRequestError({
        message,
        cause,
        ...(code !== undefined ? { code } : {}),
      })
    },
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
  headRefName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  headRepository: Schema.optionalKey(Schema.NullOr(GitHubRepositoryNameSchema)),
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
  readonly headRefName?: unknown
  readonly headRepository?: GitHubApiRepositoryReference | null
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
  return {
    number: decoded.number,
    url: decoded.url,
    nativeId: String(decoded.number),
    displayId: String(decoded.number),
  }
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
      const sourceBranch = decoded.headRefName?.trim() ?? ""
      return {
        number: decoded.number,
        repository: decoded.repository.nameWithOwner,
        state: toClosingPullRequestState(decoded.state, decoded.merged),
        isDraft: decoded.isDraft,
        sourceBranch: sourceBranch === "" ? null : sourceBranch,
        sourceRepository: decoded.headRepository?.nameWithOwner ?? null,
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
    nativeId: String(decoded.number),
    displayId: String(decoded.number),
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
  | GitHubTlsTrustError
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
  | GitHubTlsTrustError
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

const SpecIssueIdentity = Schema.Struct({
  id: Schema.NonEmptyString,
  state: Schema.Literals(["OPEN", "CLOSED"]),
})
const SpecIssue = Schema.Struct({
  ...SpecIssueIdentity.fields,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: Schema.NonEmptyString,
})
const SpecChildCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const SpecChild = Schema.Struct({
  ...SpecIssueIdentity.fields,
  stateReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subIssuesSummary: Schema.Struct({ total: SpecChildCount }),
})
const SpecIssuePageFields = {
  totalCount: true,
  pageInfo: { hasNextPage: true, endCursor: true },
} as const

const readSpecIssuePages = Effect.fn("GitHubService.readSpecIssuePages")(
  function* <A extends { readonly id: string }, E>(
    schema: Schema.Codec<A, unknown>,
    describe: string,
    readPage: (after: string | null) => Effect.Effect<unknown, E>,
    initialCount?: number,
  ) {
    const pageSchema = Schema.Struct({
      totalCount: SpecChildCount,
      nodes: Schema.Array(schema),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
    })
    const invalid = (cause?: unknown) =>
      new GitHubRequestError({
        message: `GitHub returned incomplete data while ${describe}`,
        cause,
      })
    const items = new Map<string, A>()
    const cursors = new Set<string>()
    let after: string | null = null
    let expectedCount = initialCount
    for (;;) {
      const raw: unknown = yield* readPage(after)
      const page = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(pageSchema)(raw),
        catch: invalid,
      })
      expectedCount ??= page.totalCount
      if (page.totalCount !== expectedCount) return yield* invalid()
      for (const node of page.nodes) {
        if (items.has(node.id)) return yield* invalid()
        items.set(node.id, node)
      }
      const { endCursor, hasNextPage } = page.pageInfo
      if (!hasNextPage) {
        if (items.size !== expectedCount) return yield* invalid()
        return [...items.values()]
      }
      if (
        items.size >= expectedCount ||
        page.nodes.length === 0 ||
        !endCursor?.trim() ||
        cursors.has(endCursor)
      ) {
        return yield* invalid()
      }
      cursors.add(endCursor)
      after = endCursor
    }
  },
)

const FollowUpIssue = Schema.Struct({
  id: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  body: Schema.String,
  parent: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString })),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Literal(false) }),
  }),
})
const followUpIssueFields = {
  id: true,
  url: true,
  body: true,
  parent: { id: true },
  labels: {
    __args: { first: PAGE_SIZE },
    nodes: { id: true },
    pageInfo: { hasNextPage: true },
  },
} as const

const makePublishSpecFollowUps = (client: GitHubGraphqlClient) =>
  Effect.fn("GitHubService.publishSpecFollowUps")(function* (
    repository: GitHubApiRepository,
    input: SpecFollowUpPublication,
  ) {
    const issueNumber = Number(input.parentId)
    const describe = `${repository.owner}/${repository.name}#${input.parentId}`
    const invalid = (message: string, cause?: unknown) =>
      new GitHubRequestError({ message: `${message} (${describe})`, cause })
    const mutate = client.mutation
    if (
      mutate === undefined ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      return yield* invalid("Cannot publish GitHub Spec follow-ups")
    }
    const parentResult = yield* githubQuery(
      `Reading GitHub Spec ${describe}`,
      (signal) =>
        client.query(
          {
            viewer: { login: true },
            repository: {
              __args: repository,
              id: true,
              issue: {
                __args: { number: issueNumber },
                id: true,
                state: true,
                url: true,
              },
            },
          },
          signal,
        ),
    )
    const repo = parentResult.repository
    if (repo === null)
      return yield* new GitHubApiRepositoryUnavailableError(repository)
    const parent = repo.issue
    const login = parentResult.viewer?.login?.trim()
    if (!login)
      return yield* invalid("Could not identify the authenticated GitHub user")
    if (
      !parent?.id ||
      parent.state !== "OPEN" ||
      parent.url !== input.parentUrl
    ) {
      return yield* invalid(
        "The original GitHub Spec is not open in the configured repository",
      )
    }

    // List only issues created by this credential's user. Searching or listing
    // sub-issues alone can miss a newly created but still unattached follow-up.
    const existing = yield* readSpecIssuePages(
      Schema.Struct({
        id: Schema.NonEmptyString,
        number: Schema.Int,
        body: Schema.String,
        author: Schema.NullOr(Schema.Struct({ login: Schema.NonEmptyString })),
      }),
      `finding previously created follow-ups for ${describe}`,
      (after) =>
        githubQuery(`Listing Issues for ${describe}`, (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                issues: {
                  __args: {
                    first: PAGE_SIZE,
                    after,
                    filterBy: { createdBy: login },
                  },
                  nodes: {
                    id: true,
                    number: true,
                    body: true,
                    author: { login: true },
                  },
                  ...SpecIssuePageFields,
                },
              },
            },
            signal,
          ),
        ).pipe(Effect.map((result) => result.repository?.issues)),
    )
    const links: Array<PublishedSpecFollowUps[number]> = []
    const labelIds = new Map<string, string>()
    const resolveLabelId = (label: string) =>
      Effect.gen(function* () {
        const cached = labelIds.get(label)
        if (cached !== undefined) return cached
        const labelResult = yield* githubQuery(
          `Resolving GitHub label ${label}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  label: { __args: { name: label }, id: true },
                },
              },
              signal,
            ),
        )
        const id = labelResult.repository?.label?.id
        if (!id) return yield* invalid(`Missing GitHub Issue label ${label}`)
        labelIds.set(label, id)
        return id
      })
    const publishChild = (child: SpecFollowUpPublication["children"][number]) =>
      Effect.gen(function* () {
        const { requirementId, gapId, label, title, body } = child
        const marker = specFollowUpMarker(input.parentId, requirementId, gapId)
        // The hidden marker is not proof of ownership on a public repository.
        const matches = existing.filter(
          (issue) =>
            issue.author?.login.toLowerCase() === login.toLowerCase() &&
            issue.body.split(/\r?\n/u).includes(marker),
        )
        if (matches.length > 1)
          return yield* invalid(
            `Multiple GitHub follow-ups already exist for ${requirementId}: ${gapId}`,
          )
        const labelId = yield* resolveLabelId(label)
        const found = matches[0]
        let issue: typeof FollowUpIssue.Type
        if (found === undefined) {
          // Never retry the create request itself. A retry first re-reads markers.
          const created = yield* githubRequest(
            `Creating a GitHub follow-up for ${describe}`,
            (signal) =>
              mutate(
                {
                  createIssue: {
                    __args: {
                      input: {
                        repositoryId: repo.id,
                        parentIssueId: parent.id,
                        labelIds: [labelId],
                        title,
                        body: `${body}\n\n${marker}`,
                      },
                    },
                    issue: followUpIssueFields,
                  },
                },
                signal,
              ),
          )
          issue = yield* Schema.decodeUnknownEffect(FollowUpIssue)(
            created.createIssue?.issue,
          ).pipe(
            Effect.mapError((cause) =>
              invalid("GitHub did not return the created follow-up", cause),
            ),
          )
        } else {
          const loaded = yield* githubQuery(
            `Reading GitHub follow-up #${found.number}`,
            (signal) =>
              client.query(
                {
                  repository: {
                    __args: repository,
                    issue: {
                      __args: { number: found.number },
                      ...followUpIssueFields,
                    },
                  },
                },
                signal,
              ),
          )
          issue = yield* Schema.decodeUnknownEffect(FollowUpIssue)(
            loaded.repository?.issue,
          ).pipe(
            Effect.mapError((cause) =>
              invalid("GitHub did not return the existing follow-up", cause),
            ),
          )
        }
        if (
          (found !== undefined && issue.id !== found.id) ||
          !issue.body.split(/\r?\n/u).includes(marker)
        ) {
          return yield* invalid(
            `Could not verify the identity of follow-up ${issue.url}`,
          )
        }
        if (issue.parent?.id !== parent.id) {
          if (issue.parent !== null)
            return yield* invalid(
              `Follow-up ${issue.url} belongs to another parent`,
            )
          const linked = yield* githubRequest(
            `Linking GitHub follow-up ${issue.url}`,
            (signal) =>
              mutate(
                {
                  addSubIssue: {
                    __args: {
                      input: { issueId: parent.id, subIssueId: issue.id },
                    },
                    subIssue: { parent: { id: true } },
                  },
                },
                signal,
              ),
          )
          if (linked.addSubIssue?.subIssue?.parent?.id !== parent.id) {
            return yield* invalid(`GitHub did not link follow-up ${issue.url}`)
          }
        }
        if (!issue.labels.nodes.some(({ id }) => id === labelId)) {
          const labeled = yield* githubRequest(
            `Labelling GitHub follow-up ${issue.url}`,
            (signal) =>
              mutate(
                {
                  addLabelsToLabelable: {
                    __args: {
                      input: { labelableId: issue.id, labelIds: [labelId] },
                    },
                    labelable: {
                      on_Issue: { labels: followUpIssueFields.labels },
                    },
                  },
                },
                signal,
              ),
          )
          const labelable = labeled.addLabelsToLabelable?.labelable
          const labels = Schema.decodeUnknownOption(
            FollowUpIssue.fields.labels,
          )(labelable && "labels" in labelable ? labelable.labels : undefined)
          if (
            labels._tag === "None" ||
            !labels.value.nodes.some(({ id }) => id === labelId)
          ) {
            return yield* invalid(`GitHub did not label follow-up ${issue.url}`)
          }
        }
        return { requirementId, gapId, url: issue.url }
      })
    let failure: GitHubRequestFailure | undefined
    for (const child of input.children) {
      const result = yield* Effect.result(publishChild(child))
      if (Result.isSuccess(result)) {
        links.push(result.success)
      } else {
        // Rate limiting applies to the credential, not just this child.
        if (isGitHubThrottledError(result.failure)) return yield* result.failure
        failure ??= result.failure
      }
    }
    if (links.length === 0 && failure !== undefined) return yield* failure

    const comments = yield* readSpecIssuePages(
      Schema.Struct({ id: Schema.NonEmptyString, body: Schema.String }),
      `reading findings comments on ${describe}`,
      (after) =>
        githubQuery(`Listing comments on GitHub Spec ${describe}`, (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                issue: {
                  __args: { number: issueNumber },
                  comments: {
                    __args: { first: PAGE_SIZE, after },
                    nodes: { id: true, body: true },
                    ...SpecIssuePageFields,
                  },
                },
              },
            },
            signal,
          ),
        ).pipe(Effect.map((result) => result.repository?.issue?.comments)),
    )
    const marked = comments.find(({ body }) =>
      body.split(/\r?\n/u).includes(specFindingsMarker(input.workItemId)),
    )
    const body = formatSpecFollowUpComment(input, links)
    if (marked === undefined) {
      const posted = yield* githubRequest(
        `Posting findings on GitHub Spec ${describe}`,
        (signal) =>
          mutate(
            {
              addComment: {
                __args: {
                  input: {
                    subjectId: parent.id,
                    body,
                  },
                },
                commentEdge: { node: { id: true } },
              },
            },
            signal,
          ),
      )
      if (!posted.addComment?.commentEdge?.node?.id)
        return yield* invalid("GitHub did not return the findings comment")
    } else if (marked.body !== body) {
      const updated = yield* githubRequest(
        `Updating findings on GitHub Spec ${describe}`,
        (signal) =>
          mutate(
            {
              updateIssueComment: {
                __args: { input: { id: marked.id, body } },
                issueComment: { id: true, body: true },
              },
            },
            signal,
          ),
      )
      if (
        updated.updateIssueComment?.issueComment?.id !== marked.id ||
        updated.updateIssueComment.issueComment.body !== body
      ) {
        return yield* invalid("GitHub did not update the findings comment")
      }
    }
    if (failure !== undefined) return yield* failure
    return links
  })

const makeObserveSpecs = (client: GitHubGraphqlClient) => {
  const observeDescendants = Effect.fn("GitHubService.observeSpecDescendants")(
    function* (root: typeof SpecIssueIdentity.Type) {
      const seen = new Set([root.id])
      const branches: (typeof SpecIssueIdentity.Type & {
        readonly childCount?: number
      })[] = [root]
      const descendants: { nativeId: string; closureReason: string | null }[] =
        []
      let hasOpenDescendant = false
      for (const branch of branches) {
        const describe = `reading sub-issues of GitHub Issue ${branch.id}`
        const children = yield* readSpecIssuePages(
          SpecChild,
          describe,
          (after) =>
            Effect.gen(function* () {
              // Use the global Issue ID so traversal is not confined to the
              // repository that contains the Spec.
              const result = yield* githubQuery(
                `Failed while ${describe}`,
                (signal) =>
                  client.query(
                    {
                      node: {
                        __args: { id: branch.id },
                        on_Issue: {
                          id: true,
                          state: true,
                          subIssuesSummary: { total: true },
                          subIssues: {
                            __args: { first: PAGE_SIZE, after },
                            nodes: {
                              id: true,
                              state: true,
                              stateReason: true,
                              subIssuesSummary: { total: true },
                            },
                            ...SpecIssuePageFields,
                          },
                        },
                      },
                    },
                    signal,
                  ),
              )
              const node = result?.node
              if (
                typeof node !== "object" ||
                node === null ||
                !("subIssues" in node) ||
                node.id !== branch.id ||
                node.state !== branch.state ||
                node.subIssues?.totalCount !== node.subIssuesSummary?.total
              ) {
                return yield* new GitHubRequestError({
                  message: `GitHub returned an unreadable or incomplete hierarchy while ${describe}`,
                })
              }
              return node.subIssues
            }),
          branch.childCount,
        )
        for (const child of children) {
          if (seen.has(child.id)) {
            return yield* new GitHubRequestError({
              message: `GitHub returned a duplicate descendant of Spec ${root.id}`,
            })
          }
          seen.add(child.id)
          if (child.subIssuesSummary.total > 0) {
            branches.push({
              ...child,
              childCount: child.subIssuesSummary.total,
            })
          }
          // CLOSED is enough for scheduling, including "not planned". It is
          // not a claim about delivery, nor is GitHub's completed count used.
          if (child.state === "OPEN") hasOpenDescendant = true
          else
            descendants.push({
              nativeId: child.id,
              closureReason: child.stateReason ?? null,
            })
        }
      }
      const [first, ...rest] = descendants
      return hasOpenDescendant || first === undefined
        ? { readiness: "waiting" as const }
        : {
            readiness: "all-descendants-closed" as const,
            descendants: [first, ...rest] as const,
          }
    },
  )

  return Effect.fn("GitHubService.observeSpecs")(function* (
    repository: GitHubApiRepository,
  ) {
    const describe = `listing open GitHub Specs for ${repository.owner}/${repository.name}`
    const specs = yield* readSpecIssuePages(SpecIssue, describe, (after) =>
      Effect.gen(function* () {
        const result = yield* githubQuery(
          `Failed while ${describe}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  issues: {
                    __args: {
                      first: PAGE_SIZE,
                      after,
                      labels: [SPEC_LABEL],
                      states: ["OPEN"],
                    },
                    nodes: { id: true, number: true, url: true, state: true },
                    ...SpecIssuePageFields,
                  },
                },
              },
              signal,
            ),
        )
        if (result?.repository === null) {
          return yield* new GitHubApiRepositoryUnavailableError(repository)
        }
        return result?.repository?.issues
      }),
    )
    const observations: GitHubSpecObservation[] = []
    for (const spec of specs) {
      if (spec.state !== "OPEN") continue
      const hierarchy = yield* observeDescendants(spec).pipe(
        Effect.catchIf(
          (error) =>
            error._tag === "GitHubRequestError" && error.statusCode !== 401,
          () => Effect.succeed({ readiness: "hierarchy-unavailable" as const }),
        ),
      )
      observations.push({
        nativeId: String(spec.number),
        displayId: String(spec.number),
        url: spec.url,
        ...hierarchy,
      })
    }
    return observations
  })
}

const issueLabelsSelection = (after: string | null) => ({
  __args: { first: PAGE_SIZE, after },
  nodes: { name: true },
  pageInfo: { endCursor: true, hasNextPage: true },
})

interface IssueLabelPage {
  readonly nodes: readonly ({ readonly name: string } | null)[] | null
  readonly pageInfo: {
    readonly endCursor: string | null
    readonly hasNextPage: boolean
  }
}

const hasSpecLabel = Effect.fn("GitHubService.hasSpecLabel")(function* (
  client: GitHubGraphqlClient,
  repository: GitHubApiRepository,
  issueNumber: number,
  initial: IssueLabelPage,
) {
  const issueRef = `${repository.owner}/${repository.name}#${issueNumber}`
  let labels = initial
  const seen = new Set<string>()
  for (;;) {
    if (
      labels.nodes?.some((label) => label?.name.toLowerCase() === SPEC_LABEL)
    ) {
      return true
    }
    if (labels.nodes === null || labels.nodes.some((label) => label === null)) {
      return yield* new GitHubRequestError({
        message: `GitHub returned incomplete labels for Issue ${issueRef}`,
      })
    }
    if (!labels.pageInfo.hasNextPage) return false
    const after = labels.pageInfo.endCursor
    if (!after || seen.has(after)) {
      return yield* new GitHubRequestError({
        message: `GitHub returned an invalid labels page cursor for Issue ${issueRef}`,
      })
    }
    seen.add(after)
    const result = yield* githubQuery(
      `Failed to list labels for Issue ${issueRef}`,
      (signal) =>
        client.query(
          {
            repository: {
              __args: repository,
              issue: {
                __args: { number: issueNumber },
                labels: issueLabelsSelection(after),
              },
            },
          },
          signal,
        ),
    )
    const next = result.repository?.issue?.labels
    if (!next) {
      return yield* new GitHubRequestError({
        message: `GitHub returned incomplete labels for Issue ${issueRef}`,
      })
    }
    labels = next
  }
})

type IssueCommentOutcome =
  | { readonly kind: "complete"; readonly workItemId: string }
  | { readonly kind: "comment"; readonly marker: string }

type AdaptedGitHubServiceShape = {
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

type GitHubApiServiceShape = Omit<
  AdaptedGitHubServiceShape,
  "ensureIssueCompletedWithSummary" | "ensureIssueComment"
> & {
  readonly ensureIssueCommentOutcome: (
    repository: GitHubApiRepository,
    issueNumber: number,
    outcome: IssueCommentOutcome,
    markdown: string,
  ) => Effect.Effect<void, GitHubRequestFailure>
}

const makeGitHubApiService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
  rerunWorkflowRunImpl?: RerunWorkflowRun,
  observeAutomatedReviewEvidenceImpl?: ObserveAutomatedReviewEvidence,
  uploadUserAttachmentImpl?: UploadUserAttachment,
  listCiGateCatalogImpl?: ListCiGateCatalog,
  observeCiGateImpl?: ObserveCiGate,
): GitHubApiServiceShape => ({
  observeSpecs: makeObserveSpecs(client),
  publishSpecFollowUps: makePublishSpecFollowUps(client),
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
      | GitHubTlsTrustError
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
    function* (repository, headRefName, options) {
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
      const preMergeChecks = classifyMergeCheckRollup(
        pullRequest.statusCheckRollup,
        `${repository.owner}/${repository.name}:${headRefName}`,
        options,
      )
      if (preMergeChecks._tag === "invalid") {
        return yield* new GitHubRequestError({
          message: preMergeChecks.message,
        })
      }
      if (preMergeChecks._tag === "missing_successful_checks") {
        return {
          _tag: "needs_human",
          reason: "missing_successful_checks",
          message: `No successful status checks were reported for ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (preMergeChecks._tag === "checks_not_green") {
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
          mutationResult.failure._tag !== "GitHubRequestError" ||
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
      const postMergeChecks = classifyMergeCheckRollup(
        mergedPullRequest.statusCheckRollup,
        `${repository.owner}/${repository.name}:${headRefName}`,
        options,
      )
      if (postMergeChecks._tag === "invalid") {
        return yield* new GitHubRequestError({
          message: postMergeChecks.message,
        })
      }
      if (postMergeChecks._tag === "missing_successful_checks") {
        return {
          _tag: "needs_human",
          reason: "missing_successful_checks",
          message: `No successful status checks were reported while merging ${repository.owner}/${repository.name}:${headRefName}`,
        } as const
      }
      if (postMergeChecks._tag === "checks_not_green") {
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
  uploadUserAttachment: Effect.fn("GitHubService.uploadUserAttachment")(
    function* (repository, input) {
      const name = input.name.trim()
      const contentType = input.contentType.trim()
      const filePath = input.filePath.trim()
      if (name === "" || contentType === "" || filePath === "") {
        return yield* new GitHubRequestError({
          message: `Invalid user attachment input for ${repository.owner}/${repository.name}`,
          retryable: false,
        })
      }
      if (uploadUserAttachmentImpl === undefined) {
        return yield* new GitHubRequestError({
          message: `User attachment upload is not configured for ${repository.owner}/${repository.name}`,
          retryable: false,
        })
      }
      const body = yield* Effect.tryPromise({
        try: () => readFile(filePath),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to read attachment file for ${repository.owner}/${repository.name}`,
            cause,
            retryable: false,
          }),
      })
      return yield* githubRequest(
        `Failed to upload user attachment for ${repository.owner}/${repository.name}`,
        (signal) =>
          uploadUserAttachmentImpl(
            repository,
            { name, contentType, body },
            signal,
          ),
      )
    },
  ),
  listCiGateCatalog: Effect.fn("GitHubService.listCiGateCatalog")(
    function* (repository) {
      if (listCiGateCatalogImpl === undefined) {
        return yield* new GitHubRequestError({
          message: `CI Gate catalog listing is not configured for ${repository.owner}/${repository.name}`,
          retryable: false,
        })
      }
      const listed = yield* githubRequest(
        `Failed to list CI Gate Definitions for ${repository.owner}/${repository.name}`,
        (signal) => listCiGateCatalogImpl(repository, signal),
      ).pipe(Effect.result)
      if (Result.isSuccess(listed)) {
        return listed.success
      }
      const error = listed.failure
      if (error._tag === "GitHubRequestError" && error.statusCode === 403) {
        return yield* new GitHubRequestError({
          message: `Failed to list CI Gate Definitions for ${repository.owner}/${repository.name}: Actions read required`,
          statusCode: 403,
          retryable: false,
          cause: error,
        })
      }
      return yield* error
    },
  ),
  observeCiGate: Effect.fn("GitHubService.observeCiGate")(
    function* (repository, input) {
      if (observeCiGateImpl === undefined) {
        return yield* new GitHubRequestError({
          message: `CI Gate observation is not configured for ${repository.owner}/${repository.name}`,
          retryable: false,
        })
      }
      const observed = yield* githubRequest(
        `Failed to observe CI Gate Definitions for ${repository.owner}/${repository.name}`,
        (signal) => observeCiGateImpl(repository, input, signal),
      ).pipe(Effect.result)
      if (Result.isSuccess(observed)) {
        return observed.success
      }
      const error = observed.failure
      if (error._tag === "GitHubRequestError" && error.statusCode === 403) {
        return yield* new GitHubRequestError({
          message: `Failed to observe CI Gate Definitions for ${repository.owner}/${repository.name}: Actions read required`,
          statusCode: 403,
          retryable: false,
          cause: error,
        })
      }
      return yield* error
    },
  ),
  ensureIssueCommentOutcome: Effect.fn(
    "GitHubService.ensureIssueCommentOutcome",
  )(function* (
    repository: GitHubApiRepository,
    issueNumber: number,
    outcome: IssueCommentOutcome,
    markdown: string,
  ) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return yield* new GitHubRequestError({
        message: `Invalid Issue number for ${repository.owner}/${repository.name}: ${String(issueNumber)}`,
      })
    }
    const marker =
      outcome.kind === "complete"
        ? workItemCompletionMarker(outcome.workItemId)
        : outcome.marker
    const key =
      outcome.kind === "complete" ? outcome.workItemId : outcome.marker
    if (typeof key !== "string" || key.trim() === "") {
      return yield* new GitHubRequestError({
        message: `Invalid comment key for ${repository.owner}/${repository.name}#${issueNumber}`,
      })
    }
    if (typeof markdown !== "string" || markdown.trim() === "") {
      return yield* new GitHubRequestError({
        message: `Empty Issue comment for ${repository.owner}/${repository.name}#${issueNumber}`,
      })
    }

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
      const body = `${markdown.trimEnd()}\n\n${marker}`
      const addResult = yield* githubRequest(
        `Failed to post marked comment on Issue ${issueRef}`,
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
          message: `GitHub did not return the marked comment for ${issueRef}`,
        })
      }
    }

    if (outcome.kind === "comment" || issue.state === "CLOSED") {
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
  readSpecBaseline: Effect.fn("GitHubService.readSpecBaseline")(
    function* (repository, issueNumber) {
      const issueRef = `${repository.owner}/${repository.name}#${issueNumber}`
      const result = yield* githubQuery(
        `Failed to read Spec ${issueRef}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                issue: {
                  __args: { number: issueNumber },
                  title: true,
                  body: true,
                  url: true,
                  labels: issueLabelsSelection(null),
                },
              },
            },
            signal,
          ),
      )
      if (result.repository === null) {
        return yield* new GitHubApiRepositoryUnavailableError(repository)
      }
      const issue = result.repository.issue
      if (!issue?.labels) {
        return yield* new GitHubRequestError({
          message: `GitHub returned no Issue or labels for ${issueRef}`,
        })
      }
      if (
        !(yield* hasSpecLabel(client, repository, issueNumber, issue.labels))
      ) {
        return { kind: "not-spec" }
      }

      const comments: { body: string; url: string; edited: boolean }[] = []
      let after: string | null = null
      const seen = new Set<string>()
      for (;;) {
        const page = yield* githubQuery(
          `Failed to read Spec comments for ${issueRef}`,
          (signal) =>
            client.query(
              {
                repository: {
                  __args: repository,
                  issue: {
                    __args: { number: issueNumber },
                    comments: {
                      __args: { first: PAGE_SIZE, after },
                      nodes: { body: true, url: true, lastEditedAt: true },
                      pageInfo: { endCursor: true, hasNextPage: true },
                    },
                  },
                },
              },
              signal,
            ),
        )
        const connection = page.repository?.issue?.comments
        if (!connection?.nodes) {
          return yield* new GitHubRequestError({
            message: `GitHub returned incomplete Spec comments for ${issueRef}`,
          })
        }
        for (const comment of connection.nodes) {
          if (comment === null) {
            return yield* new GitHubRequestError({
              message: `GitHub returned an unreadable Spec comment for ${issueRef}`,
            })
          }
          comments.push({
            url: comment.url,
            body: comment.body,
            edited: comment.lastEditedAt != null,
          })
        }
        if (!connection.pageInfo.hasNextPage) {
          return resolveSpecBaseline({ ...issue, marked: true }, comments)
        }
        after = connection.pageInfo.endCursor
        if (!after || seen.has(after)) {
          return yield* new GitHubRequestError({
            message: `GitHub returned an invalid Spec comments page cursor for ${issueRef}`,
          })
        }
        seen.add(after)
      }
    },
  ),
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
                      labels: issueLabelsSelection(null),
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
                          headRefName: true,
                          headRepository: { nameWithOwner: true },
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

        const issueNodes = result.repository.issues.nodes ?? []
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
          // Keep marked parents as hierarchy context, but never offer a Spec
          // without children as a standalone implementation Issue.
          if (
            !mappedIssue.hasChildren &&
            issueNode.labels &&
            (yield* hasSpecLabel(
              client,
              repository,
              mappedIssue.number,
              issueNode.labels,
            ))
          ) {
            continue
          }
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
                            headRefName: true,
                            headRepository: { nameWithOwner: true },
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
            nativeId: String(issue.number),
            displayId: String(issue.number),
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
                    nativeId: String(issue.parent.number),
                    displayId: String(issue.parent.number),
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

const toPublicRepositoryUnavailable = (
  service: GitHubApiServiceShape,
  repository: GitHubRepository,
) =>
  Effect.gen(function* () {
    const loginResult = yield* service
      .getAuthenticatedUserLogin(toGitHubApiRepository(repository))
      .pipe(Effect.result)
    if (Result.isFailure(loginResult)) {
      const error = loginResult.failure
      if (
        error._tag === "GitHubThrottledError" ||
        error._tag === "GitHubTlsTrustError" ||
        (error._tag === "GitHubRequestError" && error.statusCode === 401)
      ) {
        return yield* error
      }
      return yield* new GitHubRepositoryUnavailableError(repository)
    }
    const authenticatedLogin = loginResult.success.trim()
    if (authenticatedLogin === "") {
      return yield* new GitHubRepositoryUnavailableError(repository)
    }
    return yield* new GitHubRepositoryUnavailableError({
      ...repository,
      authenticatedLogin,
      message: formatGitHubRepositoryUnavailableMessage(
        repository.projectPath,
        authenticatedLogin,
      ),
    })
  })

const adaptRepository =
  (service: GitHubApiServiceShape) =>
  <Args extends readonly unknown[], A, E, R>(
    method: (
      repository: GitHubApiRepository,
      ...args: Args
    ) => Effect.Effect<A, E | GitHubApiRepositoryUnavailableError, R>,
  ) =>
  (
    repository: GitHubRepository,
    ...args: Args
  ): Effect.Effect<
    A,
    | E
    | GitHubRepositoryUnavailableError
    | GitHubRequestError
    | GitHubThrottledError
    | GitHubTlsTrustError,
    R
  > =>
    method(toGitHubApiRepository(repository), ...args).pipe(
      Effect.catchTag("GitHubApiRepositoryUnavailableError", () =>
        toPublicRepositoryUnavailable(service, repository),
      ),
    )

export const makeGitHubService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
  rerunWorkflowRunImpl?: RerunWorkflowRun,
  observeAutomatedReviewEvidenceImpl?: ObserveAutomatedReviewEvidence,
  uploadUserAttachmentImpl?: UploadUserAttachment,
  listCiGateCatalogImpl?: ListCiGateCatalog,
  observeCiGateImpl?: ObserveCiGate,
): GitHubServiceShape => {
  const service = makeGitHubApiService(
    client,
    listTerminalChecksForCommit,
    loadPrStatusCheckDiagnostics,
    rerunWorkflowRunImpl,
    observeAutomatedReviewEvidenceImpl,
    uploadUserAttachmentImpl,
    listCiGateCatalogImpl,
    observeCiGateImpl,
  )
  const adapt = adaptRepository(service)
  return {
    getAuthenticatedUserLogin: adapt(service.getAuthenticatedUserLogin),
    listReadyIssues: adapt(service.listReadyIssues),
    observeSpecs: adapt(service.observeSpecs),
    readSpecBaseline: adapt(service.readSpecBaseline),
    publishSpecFollowUps: adapt(service.publishSpecFollowUps),
    getPullRequestCheckStatus: adapt(service.getPullRequestCheckStatus),
    getPrStatusCheckDiagnostics: adapt(service.getPrStatusCheckDiagnostics),
    observeAutomatedReviewEvidence: adapt(
      service.observeAutomatedReviewEvidence,
    ),
    getPullRequestLifecycleStatus: adapt(service.getPullRequestLifecycleStatus),
    getOpenPullRequestNumber: adapt(service.getOpenPullRequestNumber),
    findOpenPullRequestNumber: adapt(service.findOpenPullRequestNumber),
    closeOpenPullRequestsAndDeleteBranch: adapt(
      service.closeOpenPullRequestsAndDeleteBranch,
    ),
    countOpenNonDraftPullRequests: adapt(service.countOpenNonDraftPullRequests),
    createDraftPullRequest: adapt(service.createDraftPullRequest),
    updateOpenDraftPullRequestCopy: adapt(
      service.updateOpenDraftPullRequestCopy,
    ),
    markPullRequestReadyForReview: adapt(service.markPullRequestReadyForReview),
    mergePullRequest: adapt(service.mergePullRequest),
    rerunWorkflowRun: adapt(service.rerunWorkflowRun),
    uploadUserAttachment: adapt(service.uploadUserAttachment),
    listCiGateCatalog: adapt(service.listCiGateCatalog),
    observeCiGate: adapt(service.observeCiGate),
    ensureIssueCompletedWithSummary: (
      repository,
      issueNumber,
      workItemId,
      markdown,
    ) =>
      adapt(service.ensureIssueCommentOutcome)(
        repository,
        issueNumber,
        { kind: "complete", workItemId },
        markdown,
      ),
    ensureIssueComment: (repository, issueNumber, marker, markdown) =>
      adapt(service.ensureIssueCommentOutcome)(
        repository,
        issueNumber,
        { kind: "comment", marker },
        markdown,
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
    if (response.ok) {
      return
    }
    const body = await response.text()
    const throttle = githubThrottleFromResponse({
      statusCode: response.status,
      headers: response.headers,
      message: `${response.statusText}: ${body}`,
    })
    if (throttle !== undefined) {
      throw throttle
    }
    throw new GitHubHttpError({
      statusCode: response.status,
      headers: response.headers,
      message:
        response.status === 403
          ? `Failed to rerun workflow run ${workflowRunId} for ${repository.owner}/${repository.name}: Actions write required`
          : `Failed to rerun workflow run ${workflowRunId} for ${repository.owner}/${repository.name}: ${response.statusText}: ${body}`,
    })
  }

const githubApiMessage = (body: string, fallback: string): string => {
  try {
    const parsed = JSON.parse(body) as unknown
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message.trim() !== ""
    ) {
      return parsed.message.trim()
    }
  } catch {
    // An HTML/proxy body is not useful API diagnostics.
  }
  return fallback
}

const ciRepairHttpFailure = (
  response: Response,
  body: string,
  action: string,
  runId: number,
): GitHubThrottledError | GitHubHttpError => {
  const detail = githubApiMessage(body, response.statusText).slice(0, 500)
  const message = `GitHub ${action} for workflow run ${runId} failed: HTTP ${response.status}. ${detail}`
  const throttle = githubThrottleFromResponse({
    statusCode: response.status,
    headers: response.headers,
    message,
  })
  if (throttle !== undefined) return throttle
  return new GitHubHttpError({
    statusCode: response.status,
    headers: response.headers,
    message,
  })
}

/**
 * Read the exact run, not the newest run on the branch. Load job evidence
 * only for a terminal replacement, pinned to the attempt we just observed.
 */
const readGitHubCiRepairRun = (
  token: string,
  fetchImpl: GitHubFetch,
  repository: GitHubRepository,
  runId: number,
  originalAttempt: number,
) =>
  githubRequest(
    `Could not read GitHub workflow run ${runId}`,
    async (signal): Promise<GitHubCiRepairRun> => {
      const apiRepository = toGitHubApiRepository(repository)
      const runResponse = await fetchImpl(
        `${GITHUB_API_URL}/repos/${apiRepository.owner}/${apiRepository.name}/actions/runs/${runId}`,
        { headers: githubRestHeaders(token), signal },
      )
      if (!runResponse.ok) {
        throw ciRepairHttpFailure(
          runResponse,
          await runResponse.text(),
          "read",
          runId,
        )
      }
      const run: unknown = await runResponse.json()
      if (
        !isRecord(run) ||
        run.id !== runId ||
        typeof run.run_attempt !== "number" ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt <= 0 ||
        typeof run.status !== "string"
      ) {
        throw new GitHubHttpError({
          statusCode: 502,
          headers: new Headers(),
          message: `GitHub returned invalid attempt data for workflow run ${runId}`,
        })
      }
      const attempt = run.run_attempt
      const status = run.status
      const conclusion =
        typeof run.conclusion === "string" ? run.conclusion : null
      const failedJobs: GitHubCiRepairRun["failedJobs"][number][] = []
      for (
        let page = 1;
        page <= 20 &&
        attempt > originalAttempt &&
        status === "completed" &&
        conclusion !== null &&
        conclusion !== "success";
        page++
      ) {
        const url = new URL(
          `${GITHUB_API_URL}/repos/${apiRepository.owner}/${apiRepository.name}/actions/runs/${runId}/attempts/${attempt}/jobs`,
        )
        url.searchParams.set("per_page", String(PAGE_SIZE))
        url.searchParams.set("page", String(page))
        const jobsResponse = await fetchImpl(url, {
          headers: githubRestHeaders(token),
          signal,
        })
        if (!jobsResponse.ok) {
          throw ciRepairHttpFailure(
            jobsResponse,
            await jobsResponse.text(),
            "read jobs",
            runId,
          )
        }
        const body: unknown = await jobsResponse.json()
        const pageJobs: unknown[] =
          isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []
        for (const job of pageJobs) {
          if (
            isRecord(job) &&
            typeof job.id === "number" &&
            typeof job.name === "string" &&
            typeof job.conclusion === "string" &&
            !["success", "skipped", "neutral"].includes(job.conclusion)
          ) {
            failedJobs.push({
              id: job.id,
              name: job.name,
              conclusion: job.conclusion,
            })
          }
        }
        if (pageJobs.length < PAGE_SIZE) break
      }
      return { attempt, status, conclusion, failedJobs }
    },
    { includeHttpMessage: true },
  ).pipe(
    Effect.catchTag("GitHubApiRepositoryUnavailableError", () =>
      Effect.fail(
        new GitHubRequestError({
          message: "GitHub workflow run is unavailable",
        }),
      ),
    ),
  )

/** Retry failed jobs only. Successful deployments are not replayed. */
const rerunGitHubFailedJobs = (
  token: string,
  fetchImpl: GitHubFetch,
  repository: GitHubRepository,
  runId: number,
) =>
  githubRequest(
    `Could not retry failed jobs for GitHub run ${runId}`,
    async (signal) => {
      const apiRepository = toGitHubApiRepository(repository)
      const response = await fetchImpl(
        `${GITHUB_API_URL}/repos/${apiRepository.owner}/${apiRepository.name}/actions/runs/${runId}/rerun-failed-jobs`,
        {
          method: "POST",
          headers: githubRestHeaders(token),
          signal,
        },
      )
      if (response.ok) return
      throw ciRepairHttpFailure(
        response,
        await response.text(),
        "failed-job retry",
        runId,
      )
    },
    { includeHttpMessage: true },
  ).pipe(
    Effect.catchTag("GitHubApiRepositoryUnavailableError", () =>
      Effect.fail(
        new GitHubRequestError({
          message: "GitHub workflow run is unavailable",
        }),
      ),
    ),
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mapActiveWorkflow = (value: unknown): CiGateCatalogEntry | null => {
  if (!isRecord(value) || value.state !== "active") {
    return null
  }
  const id = value.id
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null
  }
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name.length === 0) {
    return null
  }
  const path =
    typeof value.path === "string" && value.path.trim() !== ""
      ? value.path.trim()
      : null
  return {
    identity: String(id),
    displayLabel: name,
    kind: GITHUB_CI_GATE_KIND,
    diagnosticMetadata: path,
  }
}

const makeListCiGateCatalog =
  (token: string, fetchImpl: GitHubFetch): ListCiGateCatalog =>
  async (repository, signal) => {
    const entries: CiGateCatalogEntry[] = []
    for (let page = 1; ; page += 1) {
      const url = new URL(
        `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/workflows`,
      )
      url.searchParams.set("per_page", String(PAGE_SIZE))
      url.searchParams.set("page", String(page))
      const response = await fetchImpl(url, {
        headers: githubRestHeaders(token),
        signal,
      })
      if (!response.ok) {
        const body = await response.text()
        const throttle = githubThrottleFromResponse({
          statusCode: response.status,
          headers: response.headers,
          message: `${response.statusText}: ${body}`,
        })
        if (throttle !== undefined) {
          throw throttle
        }
        throw new GitHubHttpError({
          statusCode: response.status,
          headers: response.headers,
          message:
            response.status === 403
              ? `Failed to list CI Gate Definitions for ${repository.owner}/${repository.name}: Actions read required`
              : `Failed to list CI Gate Definitions for ${repository.owner}/${repository.name}: ${response.statusText}: ${body}`,
        })
      }
      const payload: unknown = await response.json()
      const workflows =
        isRecord(payload) && Array.isArray(payload.workflows)
          ? payload.workflows
          : []
      for (const workflow of workflows) {
        const mapped = mapActiveWorkflow(workflow)
        if (mapped !== null) {
          entries.push(mapped)
        }
      }
      if (workflows.length < PAGE_SIZE) {
        break
      }
    }
    return entries
  }

const CI_GATE_PULL_REQUEST_EVENTS = new Set([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_comment",
  "merge_group",
])

const CI_GATE_INCLUDED_EVENTS = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
])

const parseGitHubInstant = (value: unknown): Date | null => {
  if (typeof value !== "string" || value.trim() === "") {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const mapObservedWorkflowRun = (
  value: unknown,
  defaultBranch: string,
): CiGateObservedRun | null => {
  if (!isRecord(value)) {
    return null
  }
  const id = value.id
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null
  }
  const event = typeof value.event === "string" ? value.event.trim() : ""
  if (event === "" || CI_GATE_PULL_REQUEST_EVENTS.has(event)) {
    return null
  }
  if (!CI_GATE_INCLUDED_EVENTS.has(event)) {
    return null
  }
  const headRef =
    typeof value.head_branch === "string" ? value.head_branch.trim() : ""
  if (headRef !== defaultBranch) {
    return null
  }
  const createdAt = parseGitHubInstant(value.created_at)
  if (createdAt === null) {
    return null
  }
  const attempt =
    typeof value.run_attempt === "number" &&
    Number.isSafeInteger(value.run_attempt) &&
    value.run_attempt > 0
      ? value.run_attempt
      : 1
  const htmlUrl =
    typeof value.html_url === "string" && value.html_url.trim() !== ""
      ? value.html_url.trim()
      : null
  const headSha =
    typeof value.head_sha === "string" && value.head_sha.trim() !== ""
      ? value.head_sha.trim()
      : null
  const rawStatus =
    typeof value.status === "string" && value.status.trim() !== ""
      ? value.status.trim()
      : null
  const rawConclusion =
    typeof value.conclusion === "string" && value.conclusion.trim() !== ""
      ? value.conclusion.trim()
      : null
  return {
    runIdentity: `${String(id)}:${String(attempt)}`,
    htmlUrl,
    headSha,
    headRef,
    event,
    createdAt,
    updatedAt: parseGitHubInstant(value.updated_at),
    startedAt: parseGitHubInstant(value.run_started_at),
    rawStatus,
    rawConclusion,
    orderKey: ciGateRunOrderKey(id, attempt),
  }
}

// Job conclusions for a still-running workflow, which has no run conclusion
// yet. startup_failure is a job conclusion only. action_required is waiting
// for approval, not a failed job; a completed run with that conclusion still
// closes the gate through the run-level classification.
const JOB_FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "failed",
  "startup_failure",
])

const jobConclusionFailed = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false
  }
  const conclusion =
    typeof value.conclusion === "string"
      ? value.conclusion.trim().toLowerCase()
      : ""
  return conclusion !== "" && JOB_FAILURE_CONCLUSIONS.has(conclusion)
}

const runIdFromIdentity = (runIdentity: string): string => {
  const separator = runIdentity.indexOf(":")
  return separator === -1 ? runIdentity : runIdentity.slice(0, separator)
}

const throwGitHubHttpError = async (
  response: Response,
  message: string,
): Promise<never> => {
  const body = await response.text()
  const throttle = githubThrottleFromResponse({
    statusCode: response.status,
    headers: response.headers,
    message: `${response.statusText}: ${body}`,
  })
  if (throttle !== undefined) {
    throw throttle
  }
  throw new GitHubHttpError({
    statusCode: response.status,
    headers: response.headers,
    message,
  })
}

/**
 * A still-running run counts as a failure once any job has failed.
 * A jobs-list miss leaves the run pending so a later poll can retry;
 * throttling still fails the observation.
 */
const annotateEarlyJobFailure = async (
  fetchImpl: GitHubFetch,
  token: string,
  repository: { readonly owner: string; readonly name: string },
  run: CiGateObservedRun,
  signal: AbortSignal | undefined,
): Promise<CiGateObservedRun> => {
  const runId = runIdFromIdentity(run.runIdentity)
  if (!/^[0-9]+$/.test(runId)) {
    return run
  }
  const jobs: unknown[] = []
  const maxPages = 1
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs/${runId}/jobs`,
    )
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    if (!response.ok) {
      const body = await response.text()
      const throttle = githubThrottleFromResponse({
        statusCode: response.status,
        headers: response.headers,
        message: `${response.statusText}: ${body}`,
      })
      if (throttle !== undefined) {
        throw throttle
      }
      return run
    }
    const payload: unknown = await response.json()
    const pageJobs =
      isRecord(payload) && Array.isArray(payload.jobs) ? payload.jobs : []
    jobs.push(...pageJobs)
    if (pageJobs.some(jobConclusionFailed)) {
      return { ...run, earlyJobFailure: true }
    }
    if (pageJobs.length < PAGE_SIZE || page >= maxPages) {
      break
    }
  }
  return run
}

const isoSecond = (value: Date): string =>
  value.toISOString().replace(/\.\d{3}Z$/, "Z")

const createdNotAfter = (value: Date): string => {
  const overlapped = new Date(value.getTime() + 1000)
  return `<=${isoSecond(overlapped)}`
}

const fetchWorkflowRunPage = async (
  fetchImpl: GitHubFetch,
  token: string,
  repository: { readonly owner: string; readonly name: string },
  workflowId: number,
  defaultBranch: string,
  signal: AbortSignal | undefined,
  createdBefore: Date | null,
): Promise<{
  readonly workflowRuns: readonly unknown[]
  readonly exhausted: boolean
  readonly notFound: boolean
}> => {
  const url = new URL(
    `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/workflows/${String(workflowId)}/runs`,
  )
  url.searchParams.set("branch", defaultBranch)
  url.searchParams.set("exclude_pull_requests", "true")
  url.searchParams.set("per_page", String(PAGE_SIZE))
  url.searchParams.set("page", "1")
  if (createdBefore !== null) {
    url.searchParams.set("created", createdNotAfter(createdBefore))
  }
  const response = await fetchImpl(url, {
    headers: githubRestHeaders(token),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) {
      return { workflowRuns: [], exhausted: true, notFound: true }
    }
    const body = await response.text()
    const throttle = githubThrottleFromResponse({
      statusCode: response.status,
      headers: response.headers,
      message: `${response.statusText}: ${body}`,
    })
    if (throttle !== undefined) {
      throw throttle
    }
    throw new GitHubHttpError({
      statusCode: response.status,
      headers: response.headers,
      message:
        response.status === 403
          ? `Failed to observe CI Gate Definitions for ${repository.owner}/${repository.name}: Actions read required`
          : `Failed to observe CI Gate Definition ${String(workflowId)} for ${repository.owner}/${repository.name}: ${response.statusText}: ${body}`,
    })
  }
  const payload: unknown = await response.json()
  const workflowRuns =
    isRecord(payload) && Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : []
  return {
    workflowRuns,
    exhausted: workflowRuns.length < PAGE_SIZE,
    notFound: false,
  }
}

const newestPendingRun = (
  runs: readonly CiGateObservedRun[],
): CiGateObservedRun | undefined => {
  let newest: CiGateObservedRun | undefined
  for (const run of runs) {
    if (classifyCiGateObservedRun(run) !== "pending") {
      continue
    }
    if (newest === undefined) {
      newest = run
      continue
    }
    const newestKey = newest.orderKey
    const runKey = run.orderKey
    if (
      newestKey !== undefined &&
      runKey !== undefined &&
      compareCiGateRunOrder(runKey, newestKey) > 0
    ) {
      newest = run
    }
  }
  return newest
}

/**
 * One pending run above the history page. A miss does not fail the page.
 */
const fetchRevisitedWorkflowRun = async (
  fetchImpl: GitHubFetch,
  token: string,
  repository: { readonly owner: string; readonly name: string },
  defaultBranch: string,
  runIdentity: string,
  signal: AbortSignal | undefined,
  observeThrottle: GitHubThrottleObserver | undefined,
): Promise<CiGateObservedRun | null> => {
  const runId = runIdFromIdentity(runIdentity)
  if (!/^[0-9]+$/.test(runId)) {
    return null
  }
  try {
    const response = await fetchImpl(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs/${runId}`,
      { headers: githubRestHeaders(token), signal },
    )
    if (!response.ok) {
      const body = await response.text()
      const throttle = githubThrottleFromResponse({
        statusCode: response.status,
        headers: response.headers,
        message: `${response.statusText}: ${body}`,
      })
      if (throttle !== undefined) {
        observeThrottle?.(throttle)
      }
      return null
    }
    const payload: unknown = await response.json()
    return mapObservedWorkflowRun(payload, defaultBranch)
  } catch (error) {
    if (isGitHubThrottledError(error)) {
      observeThrottle?.(error)
    }
    return null
  }
}

const makeObserveCiGate =
  (
    token: string,
    fetchImpl: GitHubFetch,
    observeThrottle?: GitHubThrottleObserver,
  ): ObserveCiGate =>
  async (repository, input, signal) => {
    const repoResponse = await fetchImpl(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}`,
      {
        headers: githubRestHeaders(token),
        signal,
      },
    )
    if (!repoResponse.ok) {
      await throwGitHubHttpError(
        repoResponse,
        `Failed to resolve default branch for ${repository.owner}/${repository.name}: ${repoResponse.statusText}`,
      )
    }
    const repoPayload: unknown = await repoResponse.json()
    const defaultBranch =
      isRecord(repoPayload) &&
      typeof repoPayload.default_branch === "string" &&
      repoPayload.default_branch.trim() !== ""
        ? repoPayload.default_branch.trim()
        : null
    if (defaultBranch === null) {
      throw new GitHubHttpError({
        statusCode: 0,
        headers: new Headers(),
        message: `GitHub returned no default branch for ${repository.owner}/${repository.name}`,
      })
    }

    const observations: CiGateDefinitionObservation[] = []
    for (const rawIdentity of input.definitionIdentities) {
      const identity = rawIdentity.trim()
      const workflowId = Number(identity)
      if (
        identity.length === 0 ||
        !Number.isSafeInteger(workflowId) ||
        workflowId <= 0
      ) {
        observations.push({
          identity,
          kind: "unavailable",
          reason: "not_found",
          message: `CI Gate Definition ${identity} could not be observed`,
        })
        continue
      }

      const scope = input.scope ?? { kind: "latest" as const }
      if (scope.kind === "catch_up" && scope.definitionIdentity !== identity) {
        continue
      }
      const page = await fetchWorkflowRunPage(
        fetchImpl,
        token,
        repository,
        workflowId,
        defaultBranch,
        signal,
        scope.kind === "catch_up" ? scope.notNewerThan.createdAt : null,
      )
      if (page.notFound) {
        observations.push({
          identity,
          kind: "unavailable",
          reason: "not_found",
          message: `CI Gate Definition ${identity} could not be observed`,
        })
        continue
      }
      const runs: CiGateObservedRun[] = []
      for (const workflowRun of page.workflowRuns) {
        const mapped = mapObservedWorkflowRun(workflowRun, defaultBranch)
        if (mapped === null) {
          continue
        }
        if (
          scope.kind === "catch_up" &&
          mapped.orderKey !== undefined &&
          compareCiGateRunOrder(mapped.orderKey, scope.notNewerThan.orderKey) >
            0
        ) {
          continue
        }
        runs.push(mapped)
      }
      if (scope.kind === "catch_up" && scope.revisit != null) {
        const revisited = await fetchRevisitedWorkflowRun(
          fetchImpl,
          token,
          repository,
          defaultBranch,
          scope.revisit.runIdentity,
          signal,
          observeThrottle,
        )
        if (revisited !== null) {
          const existing = runs.findIndex(
            (run) =>
              runIdFromIdentity(run.runIdentity) ===
              runIdFromIdentity(revisited.runIdentity),
          )
          if (existing === -1) {
            runs.push(revisited)
          } else {
            runs[existing] = revisited
          }
        }
      }
      const newestPending = newestPendingRun(runs)
      const newest = runs.reduce<CiGateObservedRun | undefined>((best, run) => {
        if (best === undefined) {
          return run
        }
        const bestKey = best.orderKey
        const runKey = run.orderKey
        if (bestKey === undefined || runKey === undefined) {
          return best
        }
        return compareCiGateRunOrder(runKey, bestKey) > 0 ? run : best
      }, undefined)
      // A completed newest failure must not wait on jobs for older runs.
      // Otherwise inspect the newest pending run, not a cancelled or skipped
      // run that happens to be first.
      if (
        newestPending !== undefined &&
        (newest === undefined || !isDecisiveCiGateObservedRun(newest))
      ) {
        const pendingIndex = runs.indexOf(newestPending)
        if (pendingIndex !== -1) {
          try {
            runs[pendingIndex] = await annotateEarlyJobFailure(
              fetchImpl,
              token,
              repository,
              newestPending,
              signal,
            )
          } catch (error) {
            if (isGitHubThrottledError(error)) {
              observeThrottle?.(error)
            }
          }
        }
      }
      observations.push({
        identity,
        kind: "observed",
        runs,
        historyExhausted: page.exhausted,
      })
    }

    return { defaultBranch, observations }
  }

const makeUploadUserAttachment =
  (token: string, fetchImpl: GitHubFetch): UploadUserAttachment =>
  async (repository, input, signal) => {
    const repoResponse = await fetchImpl(
      `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}`,
      {
        headers: githubRestHeaders(token),
        signal,
      },
    )
    const repoBody = await readGitHubJson<{ readonly id?: unknown }>(
      repoResponse,
      `Failed to resolve repository id for ${repository.owner}/${repository.name}`,
    )
    const repositoryId = repoBody.id
    if (!Number.isSafeInteger(repositoryId) || Number(repositoryId) <= 0) {
      throw new GitHubHttpError({
        statusCode: 0,
        headers: new Headers(),
        message: `GitHub returned an invalid repository id for ${repository.owner}/${repository.name}`,
      })
    }
    const uploadUrl = new URL(GITHUB_USER_ATTACHMENTS_URL)
    uploadUrl.searchParams.set("name", input.name)
    uploadUrl.searchParams.set("content_type", input.contentType)
    uploadUrl.searchParams.set("repository_id", String(repositoryId))
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // Bun fetch leaves Buffer bodies without Content-Type; uploads.github.com then 400s.
        "Content-Type": input.contentType,
      },
      body: input.body,
      signal,
    })
    const uploaded = await readGitHubJson<{ readonly url?: unknown }>(
      uploadResponse,
      `Failed to upload user attachment for ${repository.owner}/${repository.name}`,
    )
    if (
      typeof uploaded.url !== "string" ||
      !isGitHubUserAttachmentUrl(uploaded.url)
    ) {
      throw new GitHubHttpError({
        statusCode: uploadResponse.status,
        headers: uploadResponse.headers,
        message: `GitHub returned an invalid user attachment URL for ${repository.owner}/${repository.name}`,
      })
    }
    return uploaded.url
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

type RestCommentWithBody = {
  readonly login: string
  readonly body: string
}

/**
 * List issue/PR comments in page order (oldest first). Used so the latest
 * recognized automated-reviewer comment body can be classified for incomplete
 * Automated Review Output.
 */
const listCommentsWithBodiesFromRestCollection = async (
  token: string,
  urlBase: string,
  fetchImpl: GitHubFetch,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<readonly RestCommentWithBody[]> => {
  const comments: RestCommentWithBody[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(urlBase)
    url.searchParams.set("per_page", String(PAGE_SIZE))
    url.searchParams.set("page", String(page))
    const response = await fetchImpl(url, {
      headers: githubRestHeaders(token),
      signal,
    })
    const items = await readGitHubJson<
      readonly {
        readonly user?: unknown
        readonly author?: unknown
        readonly body?: unknown
      }[]
    >(response, errorMessage)
    for (const item of items) {
      const login = loginFromAuthor(item.user) ?? loginFromAuthor(item.author)
      if (login === null) {
        continue
      }
      const body = typeof item.body === "string" ? item.body : ""
      comments.push({ login, body })
    }
    if (items.length < PAGE_SIZE) {
      break
    }
  }
  return comments
}

const fetchActionsJobExecution = async (
  token: string,
  repository: { owner: string; name: string },
  jobId: number,
  fetchImpl: GitHubFetch,
  signal?: AbortSignal,
): Promise<{
  readonly conclusion: unknown
  readonly runId: number | null
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
    readonly run_id?: unknown
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
  const runIdRaw = job.run_id
  const runId =
    typeof runIdRaw === "number" &&
    Number.isSafeInteger(runIdRaw) &&
    runIdRaw > 0
      ? runIdRaw
      : null
  return {
    conclusion: job.conclusion,
    runId,
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

      const recognizedCheck = checks.find((check) =>
        isRecognizedAutomatedReviewerName(check.name),
      )
      const workflowNameFromChecks =
        recognizedCheck !== undefined
          ? workflowNameFromCheckName(recognizedCheck.name)
          : null

      // Latest recognized issue comment body wins for incompleteness (ADR 0027/#971).
      const issueComments = yield* githubRequest(
        `Failed to list issue comments for automated review evidence on ${repository.owner}/${repository.name}#${pullNumber}`,
        (signal) =>
          listCommentsWithBodiesFromRestCollection(
            token,
            `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/issues/${pullNumber}/comments`,
            fetchImpl,
            `Failed to list issue comments for ${repository.owner}/${repository.name}#${pullNumber}`,
            signal,
          ),
      )
      let latestRecognizedIssueComment: RestCommentWithBody | null = null
      for (const comment of issueComments) {
        if (isRecognizedAutomatedReviewerLogin(comment.login)) {
          latestRecognizedIssueComment = comment
        }
      }
      if (latestRecognizedIssueComment !== null) {
        const classification = classifyIncompleteAutomatedReviewOutput(
          latestRecognizedIssueComment.body,
        )
        if (classification._tag === "incomplete") {
          let workflowRunId = extractWorkflowRunIdFromReviewComment(
            latestRecognizedIssueComment.body,
          )
          if (workflowRunId === null && recognizedCheck !== undefined) {
            const { source, actionsJobId } = parseDiagnosticSource(
              recognizedCheck.externalId,
            )
            if (source === "actions-job" && actionsJobId !== null) {
              const jobResult = yield* githubRequest(
                `Failed to load Actions job for incomplete review evidence on ${repository.owner}/${repository.name}`,
                (signal) =>
                  fetchActionsJobExecution(
                    token,
                    repository,
                    actionsJobId,
                    fetchImpl,
                    signal,
                  ),
              ).pipe(Effect.result)
              if (Result.isSuccess(jobResult)) {
                workflowRunId = jobResult.success.runId
              } else if (isGitHubThrottledError(jobResult.failure)) {
                return yield* jobResult.failure
              }
            }
          }
          return {
            _tag: "incomplete" as const,
            signature: classification.signature,
            workflowRunId,
            workflowName: workflowNameFromChecks,
            detail: `Visibly incomplete automated review comment from ${latestRecognizedIssueComment.login}`,
          }
        }
        return {
          _tag: "positive" as const,
          kind: "review_comment" as const,
          detail: `Issue comment from ${latestRecognizedIssueComment.login}`,
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
  const service = makeGitHubService(
    makeGitHubGraphqlClient(token, observingFetch),
    makeListTerminalChecksForCommit(token, observingFetch),
    makeLoadPrStatusCheckDiagnostics(token, observingFetch, fs),
    makeRerunWorkflowRun(token, observingFetch),
    makeObserveAutomatedReviewEvidence(token, observingFetch),
    makeUploadUserAttachment(token, observingFetch),
    makeListCiGateCatalog(token, observingFetch),
    makeObserveCiGate(token, observingFetch, observeThrottle),
  )
  return Object.assign(service, {
    readCiRepairRun: (
      repository: GitHubRepository,
      runId: number,
      originalAttempt: number,
    ) =>
      readGitHubCiRepairRun(
        token,
        observingFetch,
        repository,
        runId,
        originalAttempt,
      ),
    rerunFailedJobs: (repository: GitHubRepository, runId: number) =>
      rerunGitHubFailedJobs(token, observingFetch, repository, runId),
  })
}

/** Builds a live service and optionally observes successful final-quota use. */
export const makeGitHubServiceLive = (
  observeThrottle?: GitHubThrottleObserver,
): Layer.Layer<GitHubService, Config.ConfigError, FileSystem.FileSystem> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const token = yield* Config.Redacted("GITHUB_TOKEN")
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
