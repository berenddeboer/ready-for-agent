import { Config, Effect, Layer, Redacted } from "effect"
import { type Client, createClient } from "../internal/generated/index.js"
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
const GITHUB_REST_URL = "https://api.github.com"
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100

export type GitHubGraphqlClient = Pick<Client, "query"> &
  Partial<Pick<Client, "mutation">>

/**
 * Minimal REST client used for individual PR status checks.
 * Fine-grained PATs cannot read CheckRun GraphQL nodes (Checks API gap);
 * Actions jobs + classic commit statuses remain available via REST.
 */
export interface GitHubRestClient {
  readonly getJson: (path: string) => Promise<unknown>
}

interface GitHubApiPullRequest {
  readonly state: unknown
  readonly merged: unknown
  readonly headRefOid?: unknown
  readonly statusCheckRollup: { readonly state: unknown } | null
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
    return { _tag: "pending", terminalChecks: emptyTerminalChecks }
  }
  if (pullRequest.merged === true) {
    return { _tag: "succeeded", terminalChecks }
  }
  if (pullRequest.merged !== false) {
    throw new Error(
      `Invalid GitHub pull request merged value: ${pullRequest.merged}`,
    )
  }
  if (pullRequest.state === "CLOSED") {
    return { _tag: "closed" }
  }
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Invalid GitHub pull request state: ${pullRequest.state}`)
  }
  if (pullRequest.statusCheckRollup === null) {
    return { _tag: "no_checks" }
  }
  const state = pullRequest.statusCheckRollup.state
  if (state === "SUCCESS") {
    return { _tag: "succeeded", terminalChecks }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return { _tag: "failed", terminalChecks }
  }
  if (state === "EXPECTED" || state === "PENDING") {
    return { _tag: "pending", terminalChecks }
  }
  throw new Error(`Invalid GitHub status check state: ${state}`)
}

const mapActionsJob = (job: {
  readonly id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly conclusion?: unknown
}): TerminalPrStatusCheck | null => {
  if (job.status !== "completed") {
    return null
  }
  if (typeof job.id !== "number" || !Number.isSafeInteger(job.id)) {
    throw new Error("Invalid GitHub Actions job identity")
  }
  if (typeof job.name !== "string" || job.name.trim() === "") {
    throw new Error("Invalid GitHub Actions job name")
  }
  const conclusion = job.conclusion
  if (conclusion === "success") {
    return {
      externalId: `actions-job:${job.id}`,
      name: job.name,
      outcome: "green",
    }
  }
  if (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "action_required" ||
    conclusion === "startup_failure"
  ) {
    return {
      externalId: `actions-job:${job.id}`,
      name: job.name,
      outcome: "red",
    }
  }
  // cancelled, skipped, neutral, stale, etc. do not hand off
  return null
}

const mapCommitStatus = (status: {
  readonly id?: unknown
  readonly context?: unknown
  readonly state?: unknown
}): TerminalPrStatusCheck | null => {
  if (status.state === "pending") {
    return null
  }
  if (typeof status.context !== "string" || status.context.trim() === "") {
    throw new Error("Invalid GitHub commit status context")
  }
  const externalId =
    typeof status.id === "number" && Number.isSafeInteger(status.id)
      ? `status:${status.id}`
      : `status:${status.context}`
  if (status.state === "success") {
    return {
      externalId,
      name: status.context,
      outcome: "green",
    }
  }
  if (status.state === "failure" || status.state === "error") {
    return {
      externalId,
      name: status.context,
      outcome: "red",
    }
  }
  throw new Error(`Invalid GitHub commit status state: ${status.state}`)
}

const listTerminalChecksFromRest = (
  rest: GitHubRestClient,
  repository: { owner: string; name: string },
  headSha: string,
): Effect.Effect<readonly TerminalPrStatusCheck[], GitHubRequestError> =>
  Effect.gen(function* () {
    const checks: TerminalPrStatusCheck[] = []
    let runsPage = 1
    while (true) {
      const runsPath =
        `/repos/${repository.owner}/${repository.name}/actions/runs` +
        `?head_sha=${encodeURIComponent(headSha)}&per_page=${PAGE_SIZE}&page=${runsPage}`
      const runsBody = yield* Effect.tryPromise({
        try: () => rest.getJson(runsPath),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to list Actions runs for ${repository.owner}/${repository.name}@${headSha}`,
            cause,
          }),
      })
      const workflowRuns =
        typeof runsBody === "object" &&
        runsBody !== null &&
        "workflow_runs" in runsBody &&
        Array.isArray(runsBody.workflow_runs)
          ? runsBody.workflow_runs
          : []
      for (const run of workflowRuns) {
        if (
          typeof run !== "object" ||
          run === null ||
          !("id" in run) ||
          typeof run.id !== "number"
        ) {
          continue
        }
        let jobsPage = 1
        while (true) {
          const jobsPath =
            `/repos/${repository.owner}/${repository.name}/actions/runs/${run.id}/jobs` +
            `?filter=all&per_page=${PAGE_SIZE}&page=${jobsPage}`
          const jobsBody = yield* Effect.tryPromise({
            try: () => rest.getJson(jobsPath),
            catch: (cause) =>
              new GitHubRequestError({
                message: `Failed to list Actions jobs for run ${run.id} on ${repository.owner}/${repository.name}`,
                cause,
              }),
          })
          const jobs =
            typeof jobsBody === "object" &&
            jobsBody !== null &&
            "jobs" in jobsBody &&
            Array.isArray(jobsBody.jobs)
              ? jobsBody.jobs
              : []
          for (const job of jobs) {
            if (typeof job !== "object" || job === null) {
              continue
            }
            const mapped = yield* Effect.try({
              try: () => mapActionsJob(job as never),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `GitHub returned invalid Actions job data for ${repository.owner}/${repository.name}`,
                  cause,
                }),
            })
            if (mapped !== null) {
              checks.push(mapped)
            }
          }
          if (jobs.length < PAGE_SIZE) {
            break
          }
          jobsPage += 1
        }
      }
      if (workflowRuns.length < PAGE_SIZE) {
        break
      }
      runsPage += 1
    }

    let statusesPage = 1
    while (true) {
      const statusesPath =
        `/repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(headSha)}/statuses` +
        `?per_page=${PAGE_SIZE}&page=${statusesPage}`
      const statusesBody = yield* Effect.tryPromise({
        try: () => rest.getJson(statusesPath),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to list commit statuses for ${repository.owner}/${repository.name}@${headSha}`,
            cause,
          }),
      })
      const statuses = Array.isArray(statusesBody) ? statusesBody : []
      for (const status of statuses) {
        if (typeof status !== "object" || status === null) {
          continue
        }
        const mapped = yield* Effect.try({
          try: () => mapCommitStatus(status as never),
          catch: (cause) =>
            new GitHubRequestError({
              message: `GitHub returned invalid commit status data for ${repository.owner}/${repository.name}`,
              cause,
            }),
        })
        if (mapped !== null) {
          checks.push(mapped)
        }
      }
      if (statuses.length < PAGE_SIZE) {
        break
      }
      statusesPage += 1
    }

    return uniqueTerminalChecks(checks)
  })

const makeGitHubRestClient = (token: string): GitHubRestClient => ({
  getJson: async (path) => {
    const response = await fetch(`${GITHUB_REST_URL}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `GitHub REST ${path} failed with ${response.status}: ${body.slice(0, 300)}`,
      )
    }
    return response.json() as Promise<unknown>
  },
})

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

export const makeGitHubService = (
  client: GitHubGraphqlClient,
  rest?: GitHubRestClient,
): GitHubServiceShape => ({
  getPullRequestCheckStatus: (repository, headRefName) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.query({
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
                  // Aggregate only: individual CheckRun GraphQL nodes require
                  // the Checks API, which fine-grained PATs cannot use.
                  statusCheckRollup: {
                    state: true,
                  },
                },
              },
            },
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to get pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
      if (result.repository === null) {
        return yield* new GitHubRepositoryUnavailableError(repository)
      }
      const pullRequest = (result.repository.pullRequests.nodes?.[0] ??
        null) as GitHubApiPullRequest | null
      if (pullRequest === null) {
        return { _tag: "pending", terminalChecks: emptyTerminalChecks }
      }

      let terminalChecks: readonly TerminalPrStatusCheck[] = emptyTerminalChecks
      if (
        rest !== undefined &&
        pullRequest.state === "OPEN" &&
        typeof pullRequest.headRefOid === "string" &&
        pullRequest.headRefOid.trim() !== ""
      ) {
        terminalChecks = yield* listTerminalChecksFromRest(
          rest,
          repository,
          pullRequest.headRefOid,
        )
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
  getOpenPullRequestNumber: (repository, headRefName) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.query({
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
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to find open pull request for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
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
    }),
  markPullRequestReadyForReview: (repository, headRefName) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.query({
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
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to find pull request for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
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
      const mutation = yield* Effect.tryPromise({
        try: () =>
          mutate({
            markPullRequestReadyForReview: {
              __args: {
                input: { pullRequestId: pullRequest.id },
              },
              pullRequest: {
                isDraft: true,
              },
            },
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to mark pull request ready for review for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
      const readyPullRequest =
        mutation.markPullRequestReadyForReview?.pullRequest
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
  mergePullRequest: (repository, headRefName) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.query({
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
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to find pull request for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
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
      const mutation = yield* Effect.tryPromise({
        try: () =>
          mutate({
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
          }),
        catch: (cause) =>
          new GitHubRequestError({
            message: `Failed to merge pull request for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
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
    }),
  listReadyIssues: (repository) =>
    Effect.gen(function* () {
      const issues: InternalReadyLabeledIssue[] = []
      const subIssuePositions = new Map<string, number>()
      const repositoryName = `${repository.owner}/${repository.name}`
      let after: string | null = null

      while (true) {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.query({
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
            }),
          catch: (cause) =>
            new GitHubRequestError({
              message: `Failed to list Ready-labeled Issues for ${repository.owner}/${repository.name}`,
              cause,
            }),
        })

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

            const dependencyResult = yield* Effect.tryPromise({
              try: () =>
                client.query({
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
                }),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `Failed to list dependencies for ${repository.owner}/${repository.name}#${mappedIssue.number}`,
                  cause,
                }),
            })
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

            const pullRequestResult = yield* Effect.tryPromise({
              try: () =>
                client.query({
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
                }),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `Failed to list closing pull requests for ${repositoryName}#${mappedIssue.number}`,
                  cause,
                }),
            })
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

            const subIssueResult = yield* Effect.tryPromise({
              try: () =>
                client.query({
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
                }),
              catch: (cause) =>
                new GitHubRequestError({
                  message: `Failed to list sub-issues for ${repositoryName}#${mappedIssue.number}`,
                  cause,
                }),
            })
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
    }),
})

export const GitHubServiceLive = Layer.effect(
  GitHubService,
  Config.redacted("GITHUB_TOKEN").pipe(
    Effect.map((token) => {
      const value = Redacted.value(token)
      return makeGitHubService(
        createClient({
          url: GITHUB_GRAPHQL_URL,
          headers: {
            Authorization: `Bearer ${value}`,
          },
        }),
        makeGitHubRestClient(value),
      )
    }),
  ),
)
