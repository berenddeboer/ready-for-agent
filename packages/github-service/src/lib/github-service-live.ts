import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Config, Duration, Effect, Layer, Redacted, Schedule } from "effect"
import {
  type FieldsSelection,
  createClient,
} from "../internal/generated/index.js"
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

interface GitHubRestCheckRun {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
}

interface GitHubRestWorkflowRun {
  readonly id?: unknown
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
) => Promise<readonly PrStatusCheckDiagnostic[]>

const emptyTerminalChecks: readonly TerminalPrStatusCheck[] = []

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
    }
  }
  if (
    typeof pullRequest.baseRefName !== "string" ||
    pullRequest.baseRefName.trim() === ""
  ) {
    throw new Error("Invalid GitHub pull request base ref name")
  }
  const mergeability =
    pullRequest.mergeable === "MERGEABLE"
      ? "mergeable"
      : pullRequest.mergeable === "CONFLICTING"
        ? "conflicting"
        : pullRequest.mergeable === "UNKNOWN"
          ? "unknown"
          : null
  if (mergeability === null) {
    throw new Error(
      `Invalid GitHub pull request mergeability: ${pullRequest.mergeable}`,
    )
  }
  const snapshot = {
    mergeability,
    baseRefName: pullRequest.baseRefName,
    headPushedAt: parseHeadPushedAt(pullRequest),
  } as const
  if (pullRequest.merged === true) {
    return { _tag: "succeeded", terminalChecks, ...snapshot }
  }
  if (pullRequest.merged !== false) {
    throw new Error(
      `Invalid GitHub pull request merged value: ${pullRequest.merged}`,
    )
  }
  if (pullRequest.state === "CLOSED") {
    return { _tag: "closed", ...snapshot }
  }
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Invalid GitHub pull request state: ${pullRequest.state}`)
  }
  if (pullRequest.statusCheckRollup === null) {
    return { _tag: "no_checks", ...snapshot }
  }
  const state = pullRequest.statusCheckRollup.state
  if (state === "SUCCESS") {
    return { _tag: "succeeded", terminalChecks, ...snapshot }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return { _tag: "failed", terminalChecks, ...snapshot }
  }
  if (state === "EXPECTED" || state === "PENDING") {
    return { _tag: "pending", terminalChecks, ...snapshot }
  }
  throw new Error(`Invalid GitHub status check state: ${state}`)
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
  if (typeof check.id !== "number" || !Number.isSafeInteger(check.id)) {
    throw new Error("Invalid GitHub check execution identity")
  }
  if (typeof check.name !== "string" || check.name.trim() === "") {
    throw new Error("Invalid GitHub check execution name")
  }
  const conclusion = normalizeRestToken(check.conclusion)
  if (conclusion === "SUCCESS") {
    return {
      externalId: `actions-job:${check.id}`,
      name: check.name,
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
      externalId: `actions-job:${check.id}`,
      name: check.name,
      outcome: "red",
    }
  }
  return null
}

const mapRestCommitStatus = (
  status: GitHubRestCommitStatus,
): TerminalPrStatusCheck | null => {
  if (typeof status.context !== "string" || status.context.trim() === "") {
    throw new Error("Invalid GitHub commit status context")
  }
  const state = normalizeRestToken(status.state)
  if (state === "PENDING" || state === "EXPECTED") {
    return null
  }
  const identity =
    typeof status.node_id === "string" && status.node_id.trim() !== ""
      ? status.node_id
      : typeof status.id === "number" && Number.isSafeInteger(status.id)
        ? String(status.id)
        : status.context
  if (state === "SUCCESS") {
    return {
      externalId: `status:${identity}`,
      name: status.context,
      outcome: "green",
    }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return {
      externalId: `status:${identity}`,
      name: status.context,
      outcome: "red",
    }
  }
  throw new Error(`Invalid GitHub commit status state: ${status.state}`)
}

interface GitHubApiIssue {
  readonly number: unknown
  readonly title: unknown
  readonly body: unknown
  readonly url: unknown
  readonly createdAt: unknown
  readonly state: unknown
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
  if (!Number.isSafeInteger(issue.number) || Number(issue.number) <= 0) {
    throw new Error(`Invalid GitHub dependency issue number: ${issue.number}`)
  }
  if (typeof issue.url !== "string") {
    throw new Error(`Invalid GitHub dependency issue URL: ${issue.url}`)
  }
  try {
    new URL(issue.url)
  } catch {
    throw new Error(`Invalid GitHub dependency issue URL: ${issue.url}`)
  }

  return { number: Number(issue.number), url: issue.url }
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
  if (merged !== false) {
    throw new Error(`Invalid GitHub pull request merged value: ${merged}`)
  }
  if (state === "OPEN") {
    return "OPEN"
  }
  if (state === "CLOSED") {
    return "CLOSED"
  }
  throw new Error(`Invalid GitHub pull request state: ${state}`)
}

const mapClosingPullRequestPage = (
  connection: GitHubApiPullRequestConnection | undefined,
): readonly GitHubPullRequestReference[] =>
  (connection?.nodes ?? [])
    .filter((pullRequest) => pullRequest !== null)
    .map((pullRequest) => {
      if (
        !Number.isSafeInteger(pullRequest.number) ||
        Number(pullRequest.number) <= 0
      ) {
        throw new Error(
          `Invalid GitHub pull request number: ${pullRequest.number}`,
        )
      }
      if (typeof pullRequest.isDraft !== "boolean") {
        throw new Error(
          `Invalid GitHub pull request draft flag: ${pullRequest.isDraft}`,
        )
      }
      return {
        number: Number(pullRequest.number),
        repository: toRepositoryName(pullRequest.repository),
        state: toClosingPullRequestState(pullRequest.state, pullRequest.merged),
        isDraft: pullRequest.isDraft,
      }
    })

const toRepositoryName = (repository: GitHubApiRepositoryReference): string => {
  if (
    typeof repository.nameWithOwner !== "string" ||
    repository.nameWithOwner.trim() === ""
  ) {
    throw new Error("Invalid GitHub Issue repository")
  }
  return repository.nameWithOwner
}

const toIssueState = (state: unknown): GitHubIssueState => {
  if (state !== "OPEN" && state !== "CLOSED") {
    throw new Error(`Invalid GitHub issue state: ${state}`)
  }
  return state
}

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
    if (
      !Number.isSafeInteger(issue.subIssuesSummary.total) ||
      Number(issue.subIssuesSummary.total) < 0
    ) {
      throw new Error("Invalid GitHub sub-issue count")
    }
    return (
      childRepository.toLowerCase() !== repositoryName.toLowerCase() ||
      Number(issue.subIssuesSummary.total) > 0
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

const toReadyLabeledIssue = (
  issue: GitHubApiIssue,
  repositoryName: string,
): InternalReadyLabeledIssue => {
  if (!Number.isSafeInteger(issue.number) || Number(issue.number) <= 0) {
    throw new Error(`Invalid GitHub issue number: ${issue.number}`)
  }
  if (typeof issue.title !== "string" || issue.title.trim().length === 0) {
    throw new Error("Invalid GitHub issue title")
  }
  if (typeof issue.body !== "string") {
    throw new Error("Invalid GitHub issue body")
  }
  if (typeof issue.url !== "string") {
    throw new Error(`Invalid GitHub issue URL: ${issue.url}`)
  }
  try {
    new URL(issue.url)
  } catch {
    throw new Error(`Invalid GitHub issue URL: ${issue.url}`)
  }
  const state = toIssueState(issue.state)
  if (
    !Number.isSafeInteger(issue.subIssuesSummary.total) ||
    Number(issue.subIssuesSummary.total) < 0
  ) {
    throw new Error("Invalid GitHub sub-issue count")
  }
  const createdAt = new Date(String(issue.createdAt))
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Invalid GitHub issue creation time: ${issue.createdAt}`)
  }

  return {
    number: Number(issue.number),
    title: issue.title,
    body: issue.body,
    url: issue.url,
    createdAt,
    state,
    parent: issue.parent === null ? null : toIssueParent(issue.parent),
    hasChildren: Number(issue.subIssuesSummary.total) > 0,
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
export const workItemCompletionMarker = (workItemId: string): string =>
  `<!-- ready-for-agent:work-item:${workItemId} -->`

export const makeGitHubService = (
  client: GitHubGraphqlClient,
  listTerminalChecksForCommit?: ListTerminalChecksForCommit,
  loadPrStatusCheckDiagnostics?: LoadPrStatusCheckDiagnostics,
): GitHubServiceShape => ({
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
    return yield* githubRequest(
      `Failed to load PR Status Check diagnostics for ${repository.owner}/${repository.name}`,
      (signal) =>
        loadPrStatusCheckDiagnostics(repository, checks, options, signal),
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
                    state: true,
                    merged: true,
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
      if (pullRequest.merged === true || pullRequest.state === "MERGED") {
        return
      }
      if (pullRequest.state === "CLOSED") {
        return yield* new GitHubRequestError({
          message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} is closed`,
        })
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
      if (
        pullRequest.statusCheckRollup !== null &&
        pullRequest.statusCheckRollup.state !== "SUCCESS"
      ) {
        return yield* new GitHubRequestError({
          message: `Pull request checks are not successful for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (client.mutation === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub GraphQL client does not support mutations for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      const mutate = client.mutation
      const mutation = yield* githubRequest(
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
                },
              },
            },
            signal,
          ),
      )
      const mergedPullRequest = mutation.mergePullRequest?.pullRequest
      if (mergedPullRequest === null || mergedPullRequest === undefined) {
        return yield* new GitHubRequestError({
          message: `GitHub did not return a pull request after merge for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      if (
        mergedPullRequest.merged !== true &&
        mergedPullRequest.state !== "MERGED"
      ) {
        return yield* new GitHubRequestError({
          message: `Pull request for ${repository.owner}/${repository.name}:${headRefName} was not merged`,
        })
      }
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
  const runIds: number[] = []
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
    const runs = body.workflow_runs ?? []
    for (const run of runs) {
      if (typeof run.id === "number" && Number.isSafeInteger(run.id)) {
        runIds.push(run.id)
      }
    }
    if (runs.length < PAGE_SIZE) {
      break
    }
  }
  for (const runId of runIds) {
    for (let page = 1; ; page += 1) {
      const url = new URL(
        `${GITHUB_API_URL}/repos/${repository.owner}/${repository.name}/actions/runs/${runId}/jobs`,
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
        `Failed to list workflow jobs for ${repository.owner}/${repository.name} run ${runId}`,
      )
      const jobs = body.jobs ?? []
      for (const job of jobs) {
        const mapped = mapRestCheckExecution(job)
        if (mapped !== null) {
          checks.push(mapped)
        }
      }
      if (jobs.length < PAGE_SIZE) {
        break
      }
    }
  }
  return checks
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

const makeLoadPrStatusCheckDiagnostics =
  (token: string, fetchImpl: GitHubFetch): LoadPrStatusCheckDiagnostics =>
  async (repository, checks, options, signal) => {
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
      await mkdir(logDirectory, { recursive: true })
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
      try {
        const { htmlUrl, logText } = await fetchActionsJobDiagnostic(
          token,
          repository,
          actionsJobId,
          fetchImpl,
          signal,
        )
        let localPath: string | null = null
        if (logDirectory !== undefined) {
          localPath = join(logDirectory, safeLogFileName(check.externalId))
          await writeFile(localPath, logText, "utf8")
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
      } catch (cause) {
        const reason =
          cause instanceof GitHubHttpError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "Failed to load Actions job logs"
        diagnostics.push({
          externalId: check.externalId,
          name: check.name,
          source,
          htmlUrl: null,
          logFetch: {
            _tag: "unavailable",
            reason,
          },
        })
      }
    }
    return diagnostics
  }

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
): GitHubServiceShape =>
  makeGitHubService(
    makeGitHubGraphqlClient(token, fetchImpl),
    makeListTerminalChecksForCommit(token, fetchImpl),
    makeLoadPrStatusCheckDiagnostics(token, fetchImpl),
  )

export const GitHubServiceLive = Layer.effect(
  GitHubService,
  Config.redacted("GITHUB_TOKEN").pipe(
    Effect.map((token) => makeGitHubServiceFromToken(Redacted.value(token))),
  ),
)
