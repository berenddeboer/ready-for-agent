import { Effect, Either } from "effect"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type ReadyLabeledIssue,
  makeGitHubServiceTest,
} from "../src/index.js"
import {
  type GitHubGraphqlClient,
  makeGitHubService,
} from "../src/lib/github-service-live.js"
import { describe, expect, it } from "bun:test"

const repository = { owner: "acme", name: "widgets" }

const issue = (
  number: number,
  state: "OPEN" | "CLOSED" = "OPEN",
): ReadyLabeledIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  createdAt: new Date(`2026-07-${String(number).padStart(2, "0")}T12:00:00Z`),
  state,
})

describe("GitHubService live implementation", () => {
  it("fetches every ready-for-agent page and returns mapped issues by number", async () => {
    const requests: unknown[] = []
    const responses = [
      {
        repository: {
          issues: {
            nodes: [
              {
                number: 9,
                title: "Later issue",
                body: "Later body",
                url: "https://github.com/acme/widgets/issues/9",
                createdAt: "2026-07-09T12:00:00Z",
                state: "OPEN",
              },
            ],
            pageInfo: { endCursor: "page-2", hasNextPage: true },
          },
        },
      },
      {
        repository: {
          issues: {
            nodes: [
              null,
              {
                number: 2,
                title: "Earlier issue",
                body: "Earlier body",
                url: "https://github.com/acme/widgets/issues/2",
                createdAt: "2026-07-02T12:00:00Z",
                state: "CLOSED",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    ]
    const client = {
      query: async (request: unknown) => {
        requests.push(request)
        return responses.shift()
      },
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result.map(({ number }) => number)).toEqual([2, 9])
    expect(result[0]).toEqual({
      number: 2,
      title: "Earlier issue",
      body: "Earlier body",
      url: "https://github.com/acme/widgets/issues/2",
      createdAt: new Date("2026-07-02T12:00:00Z"),
      state: "CLOSED",
    })
    expect(requests).toHaveLength(2)

    const firstRequest = requests[0] as {
      repository: {
        __args: { owner: string; name: string }
        issues: {
          __args: { first: number; after: string | null; labels: string[] }
          nodes: Record<string, boolean>
        }
      }
    }
    expect(firstRequest.repository.__args).toEqual(repository)
    expect(firstRequest.repository.issues.__args).toEqual({
      first: 100,
      after: null,
      labels: ["ready-for-agent"],
    })
    expect(firstRequest.repository.issues.nodes).toEqual({
      number: true,
      title: true,
      body: true,
      url: true,
      createdAt: true,
      state: true,
    })

    const secondRequest = requests[1] as typeof firstRequest
    expect(secondRequest.repository.issues.__args.after).toBe("page-2")
  })

  it("fails when the Repository is missing or inaccessible", async () => {
    const client = {
      query: async () => ({ repository: null }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toEqual(
        new GitHubRepositoryUnavailableError(repository),
      )
    }
  })

  it("wraps GenQL failures as request errors", async () => {
    const cause = new Error("Bad credentials")
    const client = {
      query: async () => Promise.reject(cause),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitHubRequestError)
      expect(result.left.cause).toBe(cause)
    }
  })

  it("fails when GitHub reports another page without a cursor", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: true },
          },
        },
      }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitHubRequestError)
      expect(result.left.message).toContain("omitted the next page cursor")
    }
  })
})

describe("makeGitHubServiceTest", () => {
  it("looks up Repository fixtures case-insensitively and sorts their issues", async () => {
    const layer = makeGitHubServiceTest([
      { repository, issues: [issue(9), issue(2, "CLOSED")] },
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues({ owner: "ACME", name: "Widgets" })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.map(({ number }) => number)).toEqual([2, 9])
  })

  it("returns a configured request failure", async () => {
    const error = new GitHubRequestError({ message: "Rate limited" })
    const layer = makeGitHubServiceTest([{ repository, error }])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues(repository)
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result).toEqual(Either.left(error))
  })

  it("fails unavailable for a Repository without a fixture", async () => {
    const layer = makeGitHubServiceTest([])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues(repository)
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result).toEqual(
      Either.left(new GitHubRepositoryUnavailableError(repository)),
    )
  })
})
