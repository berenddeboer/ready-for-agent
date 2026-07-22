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
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
import { GitHubService, type GitHubServiceShape } from "./github-service.js"
import type {
  GitHubIssueReference,
  GitHubIssueState,
  GitHubPullRequestLifecycleState,
  GitHubPullRequestReference,
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
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100
const REQUEST_TIMEOUT = "30 seconds"
const DEFAULT_MAX_EXCERPT_CHARS = 12_000

class GitHubHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
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

const githubRequest = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestError> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new GitHubRequestError({
        message,
        cause,
        ...(cause instanceof GitHubHttpError
          ? { statusCode: cause.statusCode }
          : {}),
      }),
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(
        new GitHubRequestError({ message: `${message} timed out`, cause }),
      ),
    ),
  )

const githubQuery = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestError> =>
  githubRequest(message, request).pipe(
    Effect.retry({
      schedule: Schedule.addDelay(Schedule.recurs(2), () =>
        Effect.succeed(Duration.millis(500)),
      ),
      while: (error) => error.statusCode !== 401,
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
) => Effect.Effect<readonly PrStatusCheckDiagnostic[], GitHubRequestError>

/** Rerun an entire GitHub Actions workflow run. */
export type RerunWorkflowRun = (
  repository: { owner: string; name: string },
  workflowRunId: number,
  signal?: AbortSignal,
) => Promise<void>

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
 * yields null so callers keep the conservative no-check path.
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

const toPullRequestCheckStatus = (
  pullRequest: GitHubApiPullRequest | null | undefined,
  terminalChecks: readonly TerminalPrStatusCheck[] = emptyTerminalChecks,
): PullRequestCheckStatus => {
  if (pullRequest === null || pullRequest === undefined) {
    return {
      _tag: "pending",
      terminalChecks: emptyTerminalChecks,
      mergeability: "unknown",
      baseRefName: null,
      headPushedAt: null,
      headSha: null,
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

export const makeGitHubService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
  rerunWorkflowRunImpl?: RerunWorkflowRun,
): GitHubServiceShape => ({
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
      return yield* new GitHubRepositoryUnavailableError(repository)
    }
    const pullRequest = (result.repository.pullRequests.nodes?.[0] ??
      null) as GitHubApiPullRequest | null
    if (pullRequest === null) {
      return {
        _tag: "pending",
        terminalChecks: emptyTerminalChecks,
        mergeability: "unknown",
        baseRefName: null,
        headPushedAt: null,
        headSha: null,
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
      return yield* new GitHubRepositoryUnavailableError(repository)
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
        return yield* new GitHubRepositoryUnavailableError(repository)
      }
      const number = result.repository.pullRequests.nodes?.[0]?.number
      if (!Number.isSafeInteger(number) || Number(number) <= 0) {
        return yield* new GitHubRequestError({
          message: `No open pull request found for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      return Number(number)
    },
  ),
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
      return yield* new GitHubRepositoryUnavailableError(repository)
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
        return yield* new GitHubRepositoryUnavailableError(repository)
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
          return yield* new GitHubRepositoryUnavailableError(repository)
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
      return yield* new GitHubRepositoryUnavailableError(repository)
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
        return yield* new GitHubRepositoryUnavailableError(repository)
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
          return yield* new GitHubRepositoryUnavailableError(repository)
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
              return yield* new GitHubRepositoryUnavailableError(repository)
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
              return yield* new GitHubRepositoryUnavailableError(repository)
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
              return yield* new GitHubRepositoryUnavailableError(repository)
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
    throw new GitHubHttpError(
      response.status,
      `${message}: ${response.statusText}: ${await response.text()}`,
    )
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
      throw new GitHubHttpError(
        response.status,
        `Failed to rerun workflow run ${workflowRunId} for ${repository.owner}/${repository.name}: ${response.statusText}: ${await response.text()}`,
      )
    }
  }

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
    throw new GitHubHttpError(
      logsResponse.status,
      `Failed to download Actions job logs for ${repository.owner}/${repository.name} job ${jobId}: ${logsResponse.statusText}: ${await logsResponse.text()}`,
    )
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
          throw new GitHubHttpError(
            response.status,
            `${response.statusText}: ${await response.text()}`,
          )
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
): GitHubServiceShape =>
  makeGitHubService(
    makeGitHubGraphqlClient(token, fetchImpl),
    makeListTerminalChecksForCommit(token, fetchImpl),
    makeLoadPrStatusCheckDiagnostics(token, fetchImpl, fs),
    makeRerunWorkflowRun(token, fetchImpl),
  )

export const GitHubServiceLive = Layer.effect(
  GitHubService,
  Effect.gen(function* () {
    const token = yield* Config.redacted("GITHUB_TOKEN")
    const fs = yield* FileSystem.FileSystem
    return makeGitHubServiceFromToken(Redacted.value(token), fetch, fs)
  }),
)
