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
}

const makeRuntime = () => {
  const db: DbServiceShape = {
    addRepository: () => Effect.succeed(repository),
    storeIssue: () => Effect.die("not used"),
    listIssues: () => Effect.die("not used"),
  }
  return ManagedRuntime.make(Layer.succeed(DbService, db))
}

const graphqlRequest = (origin?: string) =>
  new Request("http://127.0.0.1:4200/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({
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
    }),
  })

describe("GraphQL API", () => {
  let runtime = makeRuntime()

  afterEach(async () => {
    await runtime.dispose()
    runtime = makeRuntime()
  })

  test("serves GraphQL through the supplied runtime", async () => {
    const response = await createGraphqlApi(runtime).fetch(graphqlRequest())

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

  test("accepts same-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest("http://127.0.0.1:4200"),
    )

    expect(response.status).toBe(200)
  })

  test("rejects cross-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest("https://malicious.example"),
    )

    expect(response.status).toBe(403)
  })
})
