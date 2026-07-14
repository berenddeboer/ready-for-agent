import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  IssueReconciler,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
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
  parentPosition: null,
  hasChildren: false,
  blockedBy: [
    {
      githubIssueNumber: 17,
      githubIssueUrl: "https://github.com/acme/widgets/issues/17",
    },
  ],
}

const makeRuntime = (
  dbOverrides: Partial<DbServiceShape> = {},
  reconcilerOverrides: Partial<IssueReconcilerShape> = {},
  keymaxxerOverrides: Partial<KeymaxxerServiceShape> = {},
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
    repositoryChanges: Stream.never,
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
  const keymaxxer: KeymaxxerServiceShape = {
    initialize: Effect.void,
    findSecret: () => Effect.succeed(null),
    findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
    hasSecret: () => Effect.succeed(false),
    addSecret: () => Effect.succeed(true),
    runWithSecrets: () => Effect.die("not used"),
    ...keymaxxerOverrides,
  }
  return ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(IssueReconciler, reconciler),
      Layer.succeed(KeymaxxerService, keymaxxer),
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

  test("streams repository membership changes", async () => {
    await runtime.dispose()
    runtime = makeRuntime({ repositoryChanges: Stream.make(undefined) })

    const response = await createGraphqlApi(runtime).fetch(
      new Request("http://127.0.0.1:4200/graphql", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "subscription { repositoriesChanged }",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toContain(
      '"data":{"repositoriesChanged":true}',
    )
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

  test("reports repository GitHub credential status", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecrets: (inputs) =>
          Effect.succeed(
            inputs.map(({ account, provider }) =>
              provider === "github" && account === "acme/widgets"
                ? "MY_GITHUB_TOKEN"
                : null,
            ),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          repositoryCredentials {
            repositoryId configured githubTokenSecretName githubTokenCreationUrl
          }
        }`,
      }),
    )
    const body = (await response.json()) as {
      data: { repositoryCredentials: Array<Record<string, unknown>> }
    }

    expect(body.data.repositoryCredentials).toEqual([
      {
        repositoryId: repository.id,
        configured: true,
        githubTokenSecretName: "MY_GITHUB_TOKEN",
        githubTokenCreationUrl: expect.stringContaining(
          "github.com/settings/personal-access-tokens/new",
        ),
      },
    ])
  })

  test("opens Keymaxxer setup for a missing repository token", async () => {
    let tokenName: string | null = null
    let addCalls = 0
    let addedInput: Parameters<KeymaxxerServiceShape["addSecret"]>[0] | null =
      null
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: () => Effect.succeed(tokenName),
        addSecret: (input) =>
          Effect.sleep("10 millis").pipe(
            Effect.map(() => {
              addCalls += 1
              addedInput = input
              tokenName = "RENAMED_GITHUB_TOKEN"
              return true
            }),
          ),
      },
    )

    const api = createGraphqlApi(runtime)
    const request = () =>
      api.fetch(
        graphqlRequest({
          query: `mutation AddToken($repositoryId: ID!) {
          addRepositoryGitHubToken(repositoryId: $repositoryId) {
            repositoryId configured githubTokenSecretName
          }
        }`,
          variables: { repositoryId: repository.id },
        }),
      )
    const [response, concurrentResponse] = await Promise.all([
      request(),
      request(),
    ])

    const expectedResponse = {
      data: {
        addRepositoryGitHubToken: {
          repositoryId: repository.id,
          configured: true,
          githubTokenSecretName: "RENAMED_GITHUB_TOKEN",
        },
      },
    }
    expect(await response.json()).toEqual(expectedResponse)
    expect(await concurrentResponse.json()).toEqual(expectedResponse)
    expect(addCalls).toBe(1)
    expect(addedInput).toEqual({
      name: "GITHUB_TOKEN_ACME_WIDGETS",
      provider: "github",
      account: "acme/widgets",
      environment: "prod",
      access: "read-only",
      description:
        "Fine-grained GitHub token for Ready for Agent on acme/widgets",
      tags: "ready-for-agent,harness,github",
    })
  })

  test("rejects a saved token whose metadata no longer matches", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: () => Effect.succeed(null),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          addRepositoryGitHubToken(repositoryId: "${repository.id}") {
            configured
          }
        }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message:
            "The saved Keymaxxer secret does not match this GitHub repository",
          extensions: { code: "REPOSITORY_CREDENTIAL_ERROR" },
        }),
      ],
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
            parent { githubIssueNumber githubIssueUrl }
            hasChildren
            blockedBy { githubIssueNumber githubIssueUrl }
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
            parent: issue.parent,
            hasChildren: issue.hasChildren,
            blockedBy: issue.blockedBy,
          },
        ],
      },
    })
    expect(requestedRepositoryId).toBe(repository.id)
  })

  test("groups child work by actionability and preserves GitHub order", async () => {
    const makeIssue = (
      githubIssueNumber: number,
      overrides: Partial<typeof issue> = {},
    ) => ({
      ...issue,
      id: `issue-${githubIssueNumber}`,
      githubIssueNumber,
      title: `Issue ${githubIssueNumber}`,
      url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
      blockedBy: [],
      ...overrides,
    })
    const parent = makeIssue(10, { hasChildren: true })
    const parentReference = {
      githubIssueNumber: 10,
      githubIssueUrl: parent.url,
    }
    await runtime.dispose()
    runtime = makeRuntime({
      listIssues: () =>
        Effect.succeed([
          makeIssue(20, { hasChildren: true }),
          makeIssue(12, {
            parent: parentReference,
            parentPosition: 0,
            state: "CLOSED",
          }),
          makeIssue(3),
          parent,
          makeIssue(11, { parent: parentReference, parentPosition: 3 }),
          makeIssue(13, {
            parent: parentReference,
            parentPosition: 1,
            blockedBy: issue.blockedBy,
          }),
          makeIssue(14, { parent: parentReference, parentPosition: 2 }),
        ]),
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query ListIssues($repositoryId: ID!) {
          issues(repositoryId: $repositoryId) {
            githubIssueNumber hasChildren
            parent { githubIssueNumber }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        issues: [
          { githubIssueNumber: 3, hasChildren: false, parent: null },
          { githubIssueNumber: 10, hasChildren: true, parent: null },
          {
            githubIssueNumber: 14,
            hasChildren: false,
            parent: { githubIssueNumber: 10 },
          },
          {
            githubIssueNumber: 11,
            hasChildren: false,
            parent: { githubIssueNumber: 10 },
          },
          {
            githubIssueNumber: 13,
            hasChildren: false,
            parent: { githubIssueNumber: 10 },
          },
          {
            githubIssueNumber: 12,
            hasChildren: false,
            parent: { githubIssueNumber: 10 },
          },
        ],
      },
    })
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
