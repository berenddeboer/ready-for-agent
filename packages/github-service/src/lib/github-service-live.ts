import { Config, Effect, Layer, Redacted } from "effect"
import { type Client, createClient } from "../internal/generated/index.js"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
import { GitHubService, type GitHubServiceShape } from "./github-service.js"
import type { GitHubIssueReference, ReadyLabeledIssue } from "./types.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const READY_FOR_AGENT_LABEL = "ready-for-agent"
const PAGE_SIZE = 100

export type GitHubGraphqlClient = Pick<Client, "query">

interface GitHubApiIssue {
  readonly number: unknown
  readonly title: unknown
  readonly body: unknown
  readonly url: unknown
  readonly createdAt: unknown
  readonly state: unknown
  readonly blockedBy: GitHubApiIssueConnection
}

interface GitHubApiIssueConnection {
  readonly nodes: readonly (GitHubApiIssueReference | null)[] | null
  readonly pageInfo: {
    readonly endCursor: string | null
    readonly hasNextPage: boolean
  }
}

interface GitHubApiIssueReference {
  readonly number: unknown
  readonly url: unknown
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
    .map(toIssueReference)

const toReadyLabeledIssue = (issue: GitHubApiIssue): ReadyLabeledIssue => {
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
  if (issue.state !== "OPEN" && issue.state !== "CLOSED") {
    throw new Error(`Invalid GitHub issue state: ${issue.state}`)
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
    state: issue.state,
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
  listReadyIssues: (repository) =>
    Effect.gen(function* () {
      const issues: ReadyLabeledIssue[] = []
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
                    blockedBy: {
                      __args: { first: PAGE_SIZE },
                      nodes: { number: true, url: true },
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
            try: () => toReadyLabeledIssue(issueNode),
            catch: (cause) =>
              new GitHubRequestError({
                message: `GitHub returned invalid Issue data for ${repository.owner}/${repository.name}`,
                cause,
              }),
          })
          const blockedBy = [...mappedIssue.blockedBy]
          let blockedByPage = issueNode.blockedBy.pageInfo

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
                        nodes: { number: true, url: true },
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

          issues.push({
            ...mappedIssue,
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

      return issues.sort((left, right) => left.number - right.number)
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
