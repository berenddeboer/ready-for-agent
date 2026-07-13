import { Effect, Layer, ManagedRuntime } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
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

const makeRuntime = (dbOverrides: Partial<DbServiceShape> = {}) => {
  const db: DbServiceShape = {
    addRepository: () => Effect.succeed(repository),
    listRepositories: Effect.succeed([repository]),
    storeIssue: () => Effect.die("not used"),
    listIssues: () => Effect.die("not used"),
    deleteIssue: () => Effect.die("not used"),
    markIssuesReconciled: () => Effect.die("not used"),
    ...dbOverrides,
  }
  return ManagedRuntime.make(Layer.succeed(DbService, db))
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
