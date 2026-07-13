import { Effect, Layer, ManagedRuntime } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  IssueReconciler,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
import { Opencode } from "@ready-for-agent/opencode"
import { createGraphqlApi } from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const repository = {
  id: "repo-test",
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/acme/widgets.git",
  isBare: true,
  paused: true,
  issuesReconciledAt: null,
}

const config = {
  defaultModel: "opencode/deepseek-v4-flash-free",
  defaultVariant: "low",
}

const issue = {
  id: "issue-test",
  repositoryId: repository.id,
  githubIssueNumber: 42,
  title: "Make repository cards useful",
  body: "Show the Ready-labeled issues.",
  url: "https://github.com/acme/widgets/issues/42",
  state: "OPEN" as const,
  githubCreatedAt: new Date("2026-07-12T10:30:00.000Z"),
  parent: null,
  blockedBy: [],
}

const makeRuntime = (
  dbOverrides: Partial<DbServiceShape> = {},
  reconcilerOverrides: Partial<IssueReconcilerShape> = {},
) => {
  const opencode = {
    start: () => Effect.die("not used"),
    continue: () => Effect.die("not used"),
    listModels: () =>
      Effect.succeed([
        "opencode/deepseek-v4-flash-free",
        "anthropic/claude-sonnet-4-5",
      ]),
  }
  const db: DbServiceShape = {
    getConfig: Effect.succeed(config),
    updateConfig: (input) => Effect.succeed(input),
    addRepository: () => Effect.succeed(repository),
    listRepositories: Effect.succeed([repository]),
    removeRepository: () => Effect.die("not used"),
    storeIssue: () => Effect.die("not used"),
    listIssues: () => Effect.die("not used"),
    deleteIssue: () => Effect.die("not used"),
    markIssuesReconciled: () => Effect.die("not used"),
    ...dbOverrides,
  }
  const reconciler: IssueReconcilerShape = {
    reconcile: () => Effect.die("not used"),
    ...reconcilerOverrides,
  }
  return ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(IssueReconciler, reconciler),
      Layer.succeed(Opencode, opencode),
    ),
  )
}

const graphqlRequest = (body: unknown, origin?: string) =>
  new Request("http://127.0.0.1:4200/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify(body),
  })

const addRepositoryRequest = (origin?: string) =>
  graphqlRequest(
    {
      query: `mutation AddRepository($input: AddRepositoryInput!) {
        addRepository(input: $input) { id githubOwner githubRepo }
      }`,
      variables: {
        input: {
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: repository.isBare,
        },
      },
    },
    origin,
  )

describe("GraphQL API", () => {
  let runtime = makeRuntime()

  afterEach(async () => {
    await runtime.dispose()
    runtime = makeRuntime()
  })

  test("serves GraphQL through the supplied runtime", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest(),
    )

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        addRepository: {
          id: repository.id,
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
        },
      },
    })
  })

  test("lists repositories", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query ListRepositories {
          repositories {
            id
            githubOwner
            githubRepo
            localPath
            isBare
            paused
            issuesReconciledAt
          }
        }`,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        repositories: [
          {
            id: repository.id,
            githubOwner: repository.githubOwner,
            githubRepo: repository.githubRepo,
            localPath: repository.localPath,
            isBare: repository.isBare,
            paused: repository.paused,
            issuesReconciledAt: null,
          },
        ],
      },
    })
  })

  test("removes a repository", async () => {
    let removedRepositoryId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime({
      removeRepository: (repositoryId) => {
        removedRepositoryId = repositoryId
        return Effect.void
      },
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RemoveRepository($repositoryId: ID!) {
          removeRepository(repositoryId: $repositoryId)
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: { removeRepository: repository.id },
    })
    expect(removedRepositoryId).toBe(repository.id)
  })

  test("reads and updates config", async () => {
    const queryResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { config { defaultModel defaultVariant } }`,
      }),
    )
    expect(await queryResponse.json()).toEqual({ data: { config } })

    const mutationResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel defaultVariant }
        }`,
        variables: {
          input: {
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
          },
        },
      }),
    )
    expect(await mutationResponse.json()).toEqual({
      data: {
        updateConfig: {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultVariant: "high",
        },
      },
    })
  })

  test("lists models provided by OpenCode", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({ query: `query { models }` }),
    )

    expect(await response.json()).toEqual({
      data: {
        models: [
          "opencode/deepseek-v4-flash-free",
          "anthropic/claude-sonnet-4-5",
        ],
      },
    })
  })

  test("lists issues for a repository", async () => {
    let requestedRepositoryId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime({
      listIssues: (repositoryId) => {
        requestedRepositoryId = repositoryId
        return Effect.succeed([issue])
      },
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query ListIssues($repositoryId: ID!) {
          issues(repositoryId: $repositoryId) {
            id repositoryId githubIssueNumber title body url state githubCreatedAt
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        issues: [
          {
            id: issue.id,
            repositoryId: issue.repositoryId,
            githubIssueNumber: issue.githubIssueNumber,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            githubCreatedAt: issue.githubCreatedAt.toISOString(),
          },
        ],
      },
    })
    expect(requestedRepositoryId).toBe(repository.id)
  })

  test("accepts batched issue queries", async () => {
    await runtime.dispose()
    runtime = makeRuntime({ listIssues: () => Effect.succeed([issue]) })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest([
        {
          query: `query First($repositoryId: ID!) {
            issues(repositoryId: $repositoryId) { id }
          }`,
          variables: { repositoryId: repository.id },
        },
        {
          query: `query Second($repositoryId: ID!) {
            issues(repositoryId: $repositoryId) { githubIssueNumber }
          }`,
          variables: { repositoryId: repository.id },
        },
      ]),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { data: { issues: [{ id: issue.id }] } },
      {
        data: {
          issues: [{ githubIssueNumber: issue.githubIssueNumber }],
        },
      },
    ])
  })

  test("refreshes a repository through the reconciler", async () => {
    let reconciledRepository: typeof repository | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        reconcile: (selectedRepository) => {
          reconciledRepository = selectedRepository
          return Effect.succeed({
            fetched: 1,
            inserted: 1,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          })
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RefreshRepository($repositoryId: ID!) {
          refreshRepository(repositoryId: $repositoryId) {
            fetched inserted updated deleted unchanged
          }
        }`,
        variables: {
          repositoryId: repository.id,
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        refreshRepository: {
          fetched: 1,
          inserted: 1,
          updated: 0,
          deleted: 0,
          unchanged: 0,
        },
      },
    })
    expect(reconciledRepository).toEqual(repository)
  })

  test("reports an unknown repository without calling the reconciler", async () => {
    let reconcilerCalled = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        reconcile: () => {
          reconcilerCalled = true
          return Effect.die("not used")
        },
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          refreshRepository(repositoryId: "missing") { fetched }
        }`,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "Repository not found: missing",
          extensions: { code: "REPOSITORY_NOT_FOUND" },
        }),
      ],
    })
    expect(reconcilerCalled).toBe(false)
  })

  test("accepts same-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest("http://127.0.0.1:4200"),
    )

    expect(response.status).toBe(200)
  })

  test("rejects cross-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest("https://malicious.example"),
    )

    expect(response.status).toBe(403)
  })
})
