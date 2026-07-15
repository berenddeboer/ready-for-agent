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
  PullRequestCheckStatus,
  ReadyLabeledIssue,
} from "./types.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100

export type GitHubGraphqlClient = Pick<Client, "query">

interface GitHubApiPullRequest {
  readonly state: unknown
  readonly merged: unknown
  readonly statusCheckRollup: { readonly state: unknown } | null
}

const toPullRequestCheckStatus = (
  pullRequest: GitHubApiPullRequest | null | undefined,
): PullRequestCheckStatus => {
  if (pullRequest === null || pullRequest === undefined) {
    return { _tag: "pending" }
  }
  if (pullRequest.merged === true) {
    return { _tag: "succeeded" }
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
  const state = pullRequest.statusCheckRollup?.state
  if (state === undefined || state === "SUCCESS") {
    return { _tag: "succeeded" }
  }
  if (state === "FAILURE" || state === "ERROR") {
    return { _tag: "failed" }
  }
  if (state === "EXPECTED" || state === "PENDING") {
    return { _tag: "pending" }
  }
  throw new Error(`Invalid GitHub status check state: ${state}`)
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
                  statusCheckRollup: { state: true },
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
      return yield* Effect.try({
        try: () =>
          toPullRequestCheckStatus(
            (result.repository.pullRequests.nodes?.[0] ??
              null) as GitHubApiPullRequest | null,
          ),
        catch: (cause) =>
          new GitHubRequestError({
            message: `GitHub returned invalid pull request checks for ${repository.owner}/${repository.name}:${headRefName}`,
            cause,
          }),
      })
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
          let blockedByPage = issueNode.blockedBy.pageInfo
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
          }
        })
        .sort((left, right) => left.number - right.number)
    }),
})

export const GitHubServiceLive = Layer.effect(
  GitHubService,
  Config.redacted("GITHUB_TOKEN").pipe(
    Effect.map((token) =>
      makeGitHubService(
        createClient({
          url: GITHUB_GRAPHQL_URL,
          headers: {
            Authorization: `Bearer ${Redacted.value(token)}`,
          },
        }),
      ),
    ),
  ),
)
