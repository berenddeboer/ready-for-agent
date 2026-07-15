import { Duration, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbService,
} from "@ready-for-agent/db-service/test"
import {
  IssueReconciler,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  EnqueueError,
  QueueService,
  type QueueServiceShape,
  makeJobId,
} from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  type WorkItemLifecycleShape,
  WorkItemNotFoundError,
  type WorkItemRecord,
  makeWorkItemId,
} from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi } from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const unused = () => Effect.die("not used")

const repository = makeRepositoryRecord({
  id: "repo-01J00000000000000000000000",
  localPath: "/repos/acme/widgets.git",
  paused: true,
})

const config = {
  defaultModel: "opencode/deepseek-v4-flash-free",
  defaultVariant: "low",
  reviewModel: null as string | null,
  reviewVariant: null as string | null,
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

const workItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: repository.id,
  githubIssueNumber: issue.githubIssueNumber,
  model: config.defaultModel,
  variant: config.defaultVariant,
  reviewModel: config.defaultModel,
  reviewVariant: config.defaultVariant,
  state: "create_worktree",
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  worktreePath: null,
  sessionId: null,
  failureCode: null,
  failureMessage: null,
  createdAt: new Date("2026-07-14T08:00:00.000Z"),
  updatedAt: new Date("2026-07-14T08:00:01.000Z"),
  stateResidenceMs: 1_000,
  stepRuns: [
    {
      id: "srun-01J00000000000000000000000",
      workItemId: "wi-01J00000000000000000000000",
      step: "create_worktree",
      status: "running",
      queueJobId: "qjob-01J00000000000000000000000",
      queuedAt: new Date("2026-07-14T08:00:00.000Z"),
      startedAt: new Date("2026-07-14T08:00:01.000Z"),
      finishedAt: null,
      reasonCode: null,
      reasonMessage: null,
      queueWaitMs: 1_000,
      executionDurationMs: 250,
    },
  ],
} as WorkItemRecord

const makeRuntime = (
  dbOverrides: Partial<DbServiceShape> = {},
  reconcilerOverrides: Partial<IssueReconcilerShape> = {},
  keymaxxerOverrides: Partial<KeymaxxerServiceShape> = {},
  queueOverrides: Partial<QueueServiceShape> = {},
  lifecycleOverrides: Partial<WorkItemLifecycleShape> = {},
  opencodeOverrides: {
    listModels?: () => Effect.Effect<ReadonlyArray<string>, never>
  } = {},
) => {
  const opencode = {
    start: () => Effect.die("not used"),
    continue: () => Effect.die("not used"),
    listModels: () =>
      Effect.succeed([
        "opencode/deepseek-v4-flash-free",
        "anthropic/claude-sonnet-4-5",
      ]),
    ...opencodeOverrides,
  }
  const db = stubDbService({
    getConfig: Effect.succeed(config),
    updateConfig: (input) => Effect.succeed(input),
    addRepository: () => Effect.succeed(repository),
    updateRepositorySettings: (input) =>
      Effect.succeed({
        ...repository,
        paused: input.paused,
        defaultModel: input.defaultModel,
        defaultVariant: input.defaultVariant,
        reviewModel: input.reviewModel,
        reviewVariant: input.reviewVariant,
        autoMerge: input.autoMerge,
      }),
    listRepositories: Effect.succeed([repository]),
    ...dbOverrides,
  })
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
    removeSecret: () => Effect.succeed(true),
    runWithSecrets: () => Effect.die("not used"),
    ...keymaxxerOverrides,
  }
  const queue: QueueServiceShape = {
    queueInTransaction: true,
    enqueue: () => Effect.succeed(makeJobId()),
    enqueueWithDelay: () => Effect.die("not used"),
    rawClaim: () => Effect.die("not used"),
    acknowledge: () => Effect.die("not used"),
    fail: () => Effect.die("not used"),
    extendVisibility: () => Effect.die("not used"),
    getStats: () => Effect.die("not used"),
    ...queueOverrides,
  }
  const lifecycle: WorkItemLifecycleShape = {
    maxDurations: {
      create_worktree: Duration.minutes(5),
      install_dependencies: Duration.minutes(15),
      implement: Duration.hours(2),
      pre_commit: Duration.hours(2),
      review: Duration.hours(1),
      commit: Duration.minutes(5),
      create_pr: Duration.minutes(10),
      watch_pr_status_checks: Duration.minutes(5),
      investigate_pr_status_checks: Duration.hours(2),
      mark_pr_ready_for_review: Duration.minutes(5),
      decide_pr_merge: Duration.minutes(15),
    },
    implementNow: unused,
    runStep: unused,
    retry: unused,
    abandon: unused,
    reset: unused,
    getWorkItem: unused,
    listWorkItemsForIssue: unused,
    listWorkItemsForRepository: unused,
    ...lifecycleOverrides,
  }
  return ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(IssueReconciler, reconciler),
      Layer.succeed(KeymaxxerService, keymaxxer),
      Layer.succeed(Opencode, opencode),
      Layer.succeed(QueueService, queue),
      Layer.succeed(WorkItemLifecycle, lifecycle),
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
            defaultModel
            defaultVariant
            autoMerge
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
            defaultModel: null,
            defaultVariant: null,
            autoMerge: false,
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
    const creationUrl = new URL(
      body.data.repositoryCredentials[0]!.githubTokenCreationUrl as string,
    )
    expect(creationUrl.searchParams.get("name")).toBe(
      `${repository.githubRepo} - ready-for-agent`,
    )
    expect(creationUrl.searchParams.get("issues")).toBe("read")
    expect(creationUrl.searchParams.get("contents")).toBe("write")
    expect(creationUrl.searchParams.get("pull_requests")).toBe("write")
    expect(creationUrl.searchParams.get("actions")).toBe("read")
    expect(creationUrl.searchParams.get("statuses")).toBe("read")
    expect(creationUrl.searchParams.get("checks")).toBeNull()
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
      access: "read-write",
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

  test("removes a repository GitHub token", async () => {
    let removedName: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: ({ account }) =>
          Effect.succeed(
            account === "acme/widgets" ? "GITHUB_TOKEN_ACME_WIDGETS" : null,
          ),
        removeSecret: (name) =>
          Effect.sync(() => {
            removedName = name
            return true
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RemoveToken($repositoryId: ID!) {
          removeRepositoryGitHubToken(repositoryId: $repositoryId) {
            repositoryId configured githubTokenSecretName
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        removeRepositoryGitHubToken: {
          repositoryId: repository.id,
          configured: false,
          githubTokenSecretName: "GITHUB_TOKEN_ACME_WIDGETS",
        },
      },
    })
    expect(removedName).toBe("GITHUB_TOKEN_ACME_WIDGETS")
  })

  test("remove repository GitHub token is idempotent when missing", async () => {
    let removeCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: () => Effect.succeed(null),
        removeSecret: () =>
          Effect.sync(() => {
            removeCalls += 1
            return false
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          removeRepositoryGitHubToken(repositoryId: "${repository.id}") {
            repositoryId configured githubTokenSecretName
          }
        }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        removeRepositoryGitHubToken: {
          repositoryId: repository.id,
          configured: false,
          githubTokenSecretName: "GITHUB_TOKEN_ACME_WIDGETS",
        },
      },
    })
    expect(removeCalls).toBe(0)
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

  test("resets a Work Item", async () => {
    const workItemId = makeWorkItemId()
    let resetWorkItemId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        reset: (id) => {
          resetWorkItemId = id
          return Effect.succeed(workItemId)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ResetWorkItem($workItemId: ID!) {
          resetWorkItem(workItemId: $workItemId)
        }`,
        variables: { workItemId },
      }),
    )

    expect(await response.json()).toEqual({
      data: { resetWorkItem: workItemId },
    })
    expect(resetWorkItemId).toBe(workItemId)
  })

  test("maps missing Work Item reset to WORK_ITEM_NOT_FOUND", async () => {
    const workItemId = "wi-01AAAAAAAAAAAAAAAAAAAAAAAA"
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        reset: (id) =>
          Effect.fail(new WorkItemNotFoundError({ workItemId: id })),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ResetWorkItem($workItemId: ID!) {
          resetWorkItem(workItemId: $workItemId)
        }`,
        variables: { workItemId },
      }),
    )

    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: `Work Item not found: ${workItemId}`,
          extensions: { code: "WORK_ITEM_NOT_FOUND" },
        }),
      ],
    })
  })

  test("reads and updates config", async () => {
    const queryResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { config { defaultModel defaultVariant reviewModel reviewVariant } }`,
      }),
    )
    expect(await queryResponse.json()).toEqual({ data: { config } })

    const mutationResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) {
            defaultModel defaultVariant reviewModel reviewVariant
          }
        }`,
        variables: {
          input: {
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
            reviewModel: "anthropic/claude-opus-4-6",
            reviewVariant: "max",
          },
        },
      }),
    )
    expect(await mutationResponse.json()).toEqual({
      data: {
        updateConfig: {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultVariant: "high",
          reviewModel: "anthropic/claude-opus-4-6",
          reviewVariant: "max",
        },
      },
    })
  })

  test("updates repository settings", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            id
            paused
            defaultModel
            defaultVariant
            reviewModel
            reviewVariant
            autoMerge
          }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
            reviewModel: "anthropic/claude-opus-4-6",
            reviewVariant: "max",
            autoMerge: true,
          },
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        updateRepositorySettings: {
          id: repository.id,
          paused: false,
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultVariant: "high",
          reviewModel: "anthropic/claude-opus-4-6",
          reviewVariant: "max",
          autoMerge: true,
        },
      },
    })
  })

  test("lists models provided by OpenCode and caches the result", async () => {
    let listCount = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {},
      {
        listModels: () => {
          listCount += 1
          return Effect.succeed([
            "opencode/deepseek-v4-flash-free",
            "anthropic/claude-sonnet-4-5",
          ])
        },
      },
    )

    const api = createGraphqlApi(runtime)
    const first = await api.fetch(graphqlRequest({ query: `query { models }` }))
    const second = await api.fetch(
      graphqlRequest({ query: `query { models }` }),
    )

    expect(await first.json()).toEqual({
      data: {
        models: [
          "opencode/deepseek-v4-flash-free",
          "anthropic/claude-sonnet-4-5",
        ],
      },
    })
    expect(await second.json()).toEqual({
      data: {
        models: [
          "opencode/deepseek-v4-flash-free",
          "anthropic/claude-sonnet-4-5",
        ],
      },
    })
    expect(listCount).toBe(1)
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

  test("lists Work Items with serialized lifecycle progress", async () => {
    let receivedArgs: readonly [string, number] | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        listWorkItemsForIssue: (repositoryId, githubIssueNumber) => {
          receivedArgs = [repositoryId, githubIssueNumber]
          return Effect.succeed([workItem])
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id state stateReadyAt createdAt updatedAt
            stepRuns { id step status queuedAt startedAt finishedAt }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: workItem.id,
            state: "CREATE_WORKTREE",
            stateReadyAt: "2026-07-14T08:00:00.000Z",
            createdAt: "2026-07-14T08:00:00.000Z",
            updatedAt: "2026-07-14T08:00:01.000Z",
            stepRuns: [
              {
                id: workItem.stepRuns[0]?.id,
                step: "CREATE_WORKTREE",
                status: "RUNNING",
                queuedAt: "2026-07-14T08:00:00.000Z",
                startedAt: "2026-07-14T08:00:01.000Z",
                finishedAt: null,
              },
            ],
          },
        ],
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("lists all Work Items for a repository", async () => {
    let receivedRepositoryId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {},
      {
        listWorkItemsForRepository: (repositoryId) => {
          receivedRepositoryId = repositoryId
          return Effect.succeed([workItem])
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!) {
          workItems(repositoryId: $repositoryId) {
            id githubIssueNumber state
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: workItem.id,
            githubIssueNumber: issue.githubIssueNumber,
            state: "CREATE_WORKTREE",
          },
        ],
      },
    })
    expect(receivedRepositoryId).toBe(repository.id)
  })

  test("hides terminal Work Items whose Issue is no longer Relevant", async () => {
    const terminalOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 120,
      state: "needs_human" as const,
      stepRuns: [],
    }
    const unfinishedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 121,
      state: "implement" as const,
      stepRuns: [],
    }
    const terminalRelevant = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: issue.githubIssueNumber,
      state: "complete" as const,
      stepRuns: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([terminalOrphan, unfinishedOrphan, terminalRelevant]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!) {
          workItems(repositoryId: $repositoryId) {
            id githubIssueNumber state
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: unfinishedOrphan.id,
            githubIssueNumber: 121,
            state: "IMPLEMENT",
          },
          {
            id: terminalRelevant.id,
            githubIssueNumber: issue.githubIssueNumber,
            state: "COMPLETE",
          },
        ],
      },
    })
  })

  test("starts a Work Item for Implement Now", async () => {
    let receivedArgs: readonly [string, number] | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        implementNow: (repositoryId, githubIssueNumber) => {
          receivedArgs = [repositoryId, githubIssueNumber]
          return Effect.succeed(workItem)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id state
            stepRuns { step status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        implementNow: {
          id: workItem.id,
          state: "CREATE_WORKTREE",
          stepRuns: [{ step: "CREATE_WORKTREE", status: "RUNNING" }],
        },
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("retries a failed Work Item", async () => {
    let receivedWorkItemId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        retry: (workItemId) => {
          receivedWorkItemId = workItemId
          return Effect.succeed(workItem)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryWorkItem($workItemId: ID!) {
          retryWorkItem(workItemId: $workItemId) { id state }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        retryWorkItem: {
          id: workItem.id,
          state: "CREATE_WORKTREE",
        },
      },
    })
    expect(receivedWorkItemId).toBe(workItem.id)
  })

  test("accepts a Refresh Job for a Paused Repository without reconciling", async () => {
    const jobId = makeJobId()
    let reconcilerCalled = false
    let enqueued:
      | {
          queue: string
          payload: Record<string, unknown>
          retryLimit: number | undefined
        }
      | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        reconcile: () => {
          reconcilerCalled = true
          return Effect.die("not used")
        },
      },
      {
        findSecret: ({ account, provider }) =>
          Effect.succeed(
            provider === "github" && account === "acme/widgets"
              ? "GITHUB_TOKEN_ACME_WIDGETS"
              : null,
          ),
      },
      {
        enqueue: (queueName, payload, options) =>
          Effect.sync(() => {
            enqueued = {
              queue: queueName,
              payload,
              retryLimit: options?.retryLimit,
            }
            return jobId
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RefreshRepository($repositoryId: ID!) {
          refreshRepository(repositoryId: $repositoryId) {
            id
            repositoryId
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
          id: jobId,
          repositoryId: repository.id,
        },
      },
    })
    expect(repository.paused).toBe(true)
    expect(reconcilerCalled).toBe(false)
    expect(enqueued).toEqual({
      queue: "jobs",
      payload: {
        _tag: "refresh-repository",
        repositoryId: repository.id,
      },
      retryLimit: 1,
    })
  })

  test("rejects refresh for an unknown repository without enqueueing", async () => {
    let enqueued = false
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
      {},
      {
        enqueue: () => {
          enqueued = true
          return Effect.succeed(makeJobId())
        },
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          refreshRepository(repositoryId: "missing") { id repositoryId }
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
    expect(enqueued).toBe(false)
    expect(reconcilerCalled).toBe(false)
  })

  test("rejects refresh when the Repository has no GitHub credential", async () => {
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: () => Effect.succeed(null),
      },
      {
        enqueue: () => {
          enqueued = true
          return Effect.succeed(makeJobId())
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          refreshRepository(repositoryId: "${repository.id}") {
            id
            repositoryId
          }
        }`,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: expect.stringMatching(/credential|token|configured/i),
          extensions: { code: "REPOSITORY_CREDENTIAL_ERROR" },
        }),
      ],
    })
    expect(enqueued).toBe(false)
  })

  test("reports enqueue failure without accepting a Refresh Job", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      },
      {
        enqueue: () =>
          Effect.fail(
            new EnqueueError({
              queue: "jobs",
              message: "queue unavailable",
            }),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          refreshRepository(repositoryId: "${repository.id}") {
            id
            repositoryId
          }
        }`,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "queue unavailable",
          extensions: { code: "ENQUEUE_ERROR" },
        }),
      ],
    })
  })

  test("streams Repository-specific issue invalidations", async () => {
    await runtime.dispose()
    runtime = makeRuntime({
      issueChanges: Stream.make(
        repository.id,
        "repo-01J11111111111111111111111",
      ),
    })

    const response = await createGraphqlApi(runtime).fetch(
      new Request("http://127.0.0.1:4200/graphql", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `subscription {
            issuesChanged(repositoryId: "${repository.id}")
          }`,
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    expect(body).toContain('"data":{"issuesChanged":true}')
    expect(body.match(/"data":\{"issuesChanged":true\}/g)?.length).toBe(1)
  })

  test("streams aggregate issue invalidations with Repository IDs", async () => {
    const otherRepositoryId = "repo-01J11111111111111111111111"
    await runtime.dispose()
    runtime = makeRuntime({
      issueChanges: Stream.make(repository.id, otherRepositoryId),
    })

    const response = await createGraphqlApi(runtime).fetch(
      new Request("http://127.0.0.1:4200/graphql", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "subscription { repositoryIssuesChanged }",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      `"data":{"repositoryIssuesChanged":"${otherRepositoryId}"}`,
    )
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
