import { Effect, Layer, ManagedRuntime } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  IssueReconciler,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
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

const makeRuntime = (
  dbOverrides: Partial<DbServiceShape> = {},
  reconcilerOverrides: Partial<IssueReconcilerShape> = {},
) => {
  const db: DbServiceShape = {
    getConfig: Effect.succeed(config),
    updateConfig: (input) => Effect.succeed(input),
    addRepository: () => Effect.succeed(repository),
    listRepositories: Effect.succeed([repository]),
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
    Layer.merge(
      Layer.succeed(DbService, db),
      Layer.succeed(IssueReconciler, reconciler),
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
          },
        ],
      },
    })
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
