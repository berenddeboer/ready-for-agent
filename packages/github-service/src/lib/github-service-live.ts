import { Config, Effect, Layer, Redacted } from "effect"
import { type Client, createClient } from "../internal/generated/index.js"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
import { GitHubService, type GitHubServiceShape } from "./github-service.js"
import type { ReadyLabeledIssue } from "./types.js"

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
}

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
  }
}

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

        const mappedIssues = yield* Effect.try({
          try: () =>
            (
              (result.repository.issues.nodes ??
                []) as readonly (GitHubApiIssue | null)[]
            )
              .filter((issue) => issue !== null)
              .map(toReadyLabeledIssue),
          catch: (cause) =>
            new GitHubRequestError({
              message: `GitHub returned invalid Issue data for ${repository.owner}/${repository.name}`,
              cause,
            }),
        })
        issues.push(...mappedIssues)

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
