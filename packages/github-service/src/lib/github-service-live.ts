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
  PullRequestCheckStatus,
  ReadyLabeledIssue,
  TerminalPrStatusCheck,
} from "./types.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100
const REQUEST_TIMEOUT = "30 seconds"

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

const githubRequest = <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, GitHubRequestError> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => new GitHubRequestError({ message, cause }),
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
    }),
  )

interface GitHubApiCheckRun {
  readonly __typename?: "CheckRun"
  readonly databaseId?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
}

interface GitHubApiStatusContext {
  readonly __typename?: "StatusContext"
  readonly id?: unknown
  readonly context?: unknown
  readonly state?: unknown
}

interface GitHubApiPullRequest {
  readonly state: unknown
  readonly merged: unknown
  readonly headRefOid?: unknown
  readonly baseRefName: unknown
  readonly mergeable: unknown
  readonly statusCheckRollup: {
    readonly state: unknown
    readonly contexts?: {
      readonly nodes?:
        | readonly (GitHubApiCheckRun | GitHubApiStatusContext | null)[]
        | null
      readonly pageInfo?: {
        readonly endCursor?: unknown
        readonly hasNextPage?: unknown
      }
    }
  } | null
}

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

const mapCheckRun = (
  check: GitHubApiCheckRun,
): TerminalPrStatusCheck | null => {
  if (check.status !== "COMPLETED") {
    return null
  }
  if (
    typeof check.databaseId !== "number" ||
    !Number.isSafeInteger(check.databaseId)
  ) {
    throw new Error("Invalid GitHub CheckRun identity")
  }
  if (typeof check.name !== "string" || check.name.trim() === "") {
    throw new Error("Invalid GitHub CheckRun name")
  }
  const conclusion = check.conclusion
  if (conclusion === "SUCCESS") {
    return {
      externalId: `actions-job:${check.databaseId}`,
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
      externalId: `actions-job:${check.databaseId}`,
      name: check.name,
      outcome: "red",
    }
  }
  // CANCELLED, SKIPPED, NEUTRAL, STALE, etc. do not hand off
  return null
}

const mapStatusContext = (
  status: GitHubApiStatusContext,
): TerminalPrStatusCheck | null => {
  if (status.state === "PENDING" || status.state === "EXPECTED") {
    return null
  }
  if (typeof status.context !== "string" || status.context.trim() === "") {
    throw new Error("Invalid GitHub StatusContext name")
  }
  const externalId =
    typeof status.id === "string" && status.id.trim() !== ""
      ? `status:${status.id}`
      : `status:${status.context}`
  if (status.state === "SUCCESS") {
    return {
      externalId,
      name: status.context,
      outcome: "green",
    }
  }
  if (status.state === "FAILURE" || status.state === "ERROR") {
    return {
      externalId,
      name: status.context,
      outcome: "red",
    }
  }
  throw new Error(`Invalid GitHub StatusContext state: ${status.state}`)
}

const terminalChecksFromRollup = (
  rollup: GitHubApiPullRequest["statusCheckRollup"],
  repository: { owner: string; name: string },
): Effect.Effect<readonly TerminalPrStatusCheck[], GitHubRequestError> => {
  if (rollup === null || rollup.contexts?.nodes === undefined) {
    return Effect.succeed(emptyTerminalChecks)
  }
  const checks: TerminalPrStatusCheck[] = []
  for (const node of rollup.contexts.nodes ?? []) {
    if (node === null || typeof node !== "object") {
      continue
    }
    const mapped = (() => {
      try {
        if (
          node.__typename === "CheckRun" ||
          ("databaseId" in node && "conclusion" in node)
        ) {
          return mapCheckRun(node as GitHubApiCheckRun)
        }
        if (
          node.__typename === "StatusContext" ||
          ("context" in node && "state" in node)
        ) {
          return mapStatusContext(node as GitHubApiStatusContext)
        }
        return null
      } catch (cause) {
        return new GitHubRequestError({
          message: `GitHub returned invalid status check data for ${repository.owner}/${repository.name}`,
          cause,
        })
      }
    })()
    if (mapped instanceof GitHubRequestError) {
      return Effect.fail(mapped)
    }
    if (mapped !== null) {
      checks.push(mapped)
    }
  }
  return Effect.succeed(uniqueTerminalChecks(checks))
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
      return {
        number: Number(pullRequest.number),
        repository: toRepositoryName(pullRequest.repository),
        state: toClosingPullRequestState(pullRequest.state, pullRequest.merged),
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

const statusCheckRollupSelection = (after?: string) =>
  ({
    state: true,
    contexts: {
      __args: { first: PAGE_SIZE, ...(after === undefined ? {} : { after }) },
      nodes: {
        __typename: true,
        on_CheckRun: {
          databaseId: true,
          name: true,
          status: true,
          conclusion: true,
        },
        on_StatusContext: {
          id: true,
          context: true,
          state: true,
        },
      },
      pageInfo: { endCursor: true, hasNextPage: true },
    },
  }) as const

export const makeGitHubService = (
  client: GitHubGraphqlClient,
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
                  statusCheckRollup: statusCheckRollupSelection(),
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
      }
    }

    const terminalChecks = [
      ...(yield* terminalChecksFromRollup(
        pullRequest.statusCheckRollup,
        repository,
      )),
    ]
    let pageInfo = pullRequest.statusCheckRollup?.contexts?.pageInfo
    while (pageInfo?.hasNextPage === true) {
      const after = pageInfo.endCursor
      if (typeof after !== "string") {
        return yield* new GitHubRequestError({
          message: `GitHub returned invalid status check pagination for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      const page = yield* githubQuery(
        `Failed to get pull request check page for ${repository.owner}/${repository.name}:${headRefName}`,
        (signal) =>
          client.query(
            {
              repository: {
                __args: repository,
                pullRequests: {
                  __args: { first: 1, headRefName },
                  nodes: {
                    statusCheckRollup: statusCheckRollupSelection(after),
                  },
                },
              },
            },
            signal,
          ),
      )
      if (page.repository === null) {
        return yield* new GitHubRepositoryUnavailableError(repository)
      }
      const rollup = (page.repository.pullRequests.nodes?.[0]
        ?.statusCheckRollup ??
        null) as GitHubApiPullRequest["statusCheckRollup"]
      if (rollup === null) {
        return yield* new GitHubRequestError({
          message: `GitHub omitted status check page data for ${repository.owner}/${repository.name}:${headRefName}`,
        })
      }
      terminalChecks.push(
        ...(yield* terminalChecksFromRollup(rollup, repository)),
      )
      pageInfo = rollup?.contexts?.pageInfo
    }

    return yield* Effect.try({
      try: () =>
        toPullRequestCheckStatus(
          pullRequest,
          uniqueTerminalChecks(terminalChecks),
        ),
      catch: (cause) =>
        new GitHubRequestError({
          message: `GitHub returned invalid pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
          cause,
        }),
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

const makeGitHubGraphqlClient = (token: string): GitHubGraphqlClient => {
  const client = (signal?: AbortSignal) =>
    createClient({
      url: GITHUB_GRAPHQL_URL,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

  return {
    query: (request, signal) => client(signal).query(request),
    mutation: (request, signal) => client(signal).mutation(request),
  }
}

export const GitHubServiceLive = Layer.effect(
  GitHubService,
  Config.redacted("GITHUB_TOKEN").pipe(
    Effect.map((token) =>
      makeGitHubService(makeGitHubGraphqlClient(Redacted.value(token))),
    ),
  ),
)
