import { Duration, Effect, Layer, ManagedRuntime, Stream } from "effect"
import {
  ActiveAgentBackend,
  type ActiveAgentBackendShape,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  type SessionTelemetry,
  missingSessionTelemetry,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbService,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRepositoryUnavailableError,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import {
  DirectoryPicker,
  LocalGit,
  type LocalRepository,
  NotAGitRepository,
} from "@ready-for-agent/local-git"
import {
  EnqueueError,
  QueueService,
  type QueueServiceShape,
  makeJobId,
} from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import {
  STEP_RUN_REASON,
  WAITING_FOR_AGENT_TURN_MESSAGE,
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
  selectedAgentBackend: "opencode",
  defaultModel: "opencode/deepseek-v4-flash-free",
  defaultThinkingLevel: "low",
  reviewModel: null as string | null,
  reviewThinkingLevel: null as string | null,
  maxConcurrentAgentTurns: 2,
  maxConcurrentWorkItems: 5,
}

const defaultModels = [
  {
    id: "opencode/deepseek-v4-flash-free",
    thinkingLevels: ["high", "max"],
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    thinkingLevels: ["low", "medium", "high", "max"],
  },
] as const

const readyRuntimeStatus = (
  models: AgentBackendRuntimeStatus["models"] = defaultModels,
  backendId: AgentBackendId = "opencode",
): AgentBackendRuntimeStatus => ({
  backend: {
    id: backendId,
    label: backendId === "opencode" ? "OpenCode" : backendId,
  },
  kind: "ready",
  reason: null,
  models,
})

const readyStatus = (
  models: AgentBackendStatus["models"] = defaultModels,
): AgentBackendStatus => toAgentBackendStatus(readyRuntimeStatus(models))

const issue = {
  id: "issue-test",
  repositoryId: repository.id,
  githubIssueNumber: 42,
  title: "Make repository cards useful",
  body: "Show the Ready-labeled issues.",
  url: "https://github.com/acme/widgets/issues/42",
  state: "OPEN" as const,
  githubCreatedAt: new Date("2026-07-12T10:30:00.000Z"),
  issueAuthor: "octocat",
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
  issueTitle: issue.title,
  agentBackend: "opencode",
  state: "create_worktree",
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  paused: false,
  waitingSince: null,
  waitingForBlockers: false,
  mergeMode: "ordinary",
  holdsWorkerSlot: true,
  pauseBeforeStep: null,
  worktreePath: null,
  startingCommitOid: null,
  completionSummary: null,
  sessionId: null,
  githubPullRequestNumber: null,
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

const defaultGithub: GitHubServiceShape = {
  getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(1),
  createDraftPullRequest: () => Effect.succeed(1),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  getPullRequestLifecycleStatus: () => Effect.succeed({ _tag: "open" }),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  rerunWorkflowRun: () => Effect.void,
  ensureIssueCompletedWithSummary: () => Effect.void,
  listReadyIssues: () => Effect.succeed([]),
}

const makeRuntime = (
  dbOverrides: Partial<DbServiceShape> = {},
  keymaxxerOverrides: Partial<KeymaxxerServiceShape> = {},
  queueOverrides: Partial<QueueServiceShape> = {},
  lifecycleOverrides: Partial<WorkItemLifecycleShape> = {},
  activeBackendOverrides: Partial<ActiveAgentBackendShape> = {},
  localGitOverrides: Partial<{
    readonly inspect: (path: string) => Effect.Effect<LocalRepository, unknown>
  }> = {},
  githubOverrides: Partial<GitHubServiceShape> = {},
) => {
  const db = stubDbService({
    getConfig: Effect.succeed(config),
    updateConfig: (input) =>
      Effect.succeed({
        selectedAgentBackend: input.selectedAgentBackend,
        defaultModel: input.defaultModel,
        defaultThinkingLevel: input.defaultThinkingLevel,
        reviewModel: input.reviewModel,
        reviewThinkingLevel: input.reviewThinkingLevel,
        maxConcurrentAgentTurns: input.maxConcurrentAgentTurns,
        maxConcurrentWorkItems: input.maxConcurrentWorkItems,
      }),
    addRepository: () => Effect.succeed(repository),
    updateRepositorySettings: (input) =>
      Effect.succeed({
        ...repository,
        paused: input.paused,
        selectedAgentBackend:
          input.selectedAgentBackend === undefined
            ? repository.selectedAgentBackend
            : input.selectedAgentBackend,
        defaultModel: input.defaultModel,
        defaultThinkingLevel: input.defaultThinkingLevel,
        reviewModel: input.reviewModel,
        reviewThinkingLevel: input.reviewThinkingLevel,
        autoMerge: input.autoMerge,
        includeAllIssueAuthors: input.includeAllIssueAuthors,
        waitForReadyForReviewChecks: input.waitForReadyForReviewChecks,
      }),
    listRepositories: Effect.succeed([repository]),
    listSelectedOrInUseBackendIds: Effect.succeed([
      config.selectedAgentBackend,
    ]),
    ...dbOverrides,
  })
  const keymaxxer: KeymaxxerServiceShape = {
    initialize: Effect.void,
    findSecret: () => Effect.succeed(null),
    findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
    hasSecret: () => Effect.succeed(false),
    addSecret: () => Effect.succeed(true),
    runWithSecrets: () => Effect.die("not used"),
    ...keymaxxerOverrides,
  }
  const queue = stubQueueService({
    enqueue: () => Effect.succeed(makeJobId()),
    requeueByPayloadTag: () => Effect.succeed(0),
    ...queueOverrides,
  })
  const lifecycle: WorkItemLifecycleShape = {
    maxDurations: {
      create_worktree: Duration.minutes(5),
      install_dependencies: Duration.minutes(15),
      implement: Duration.hours(2),
      assess_changes: Duration.minutes(5),
      pre_commit: Duration.hours(2),
      review: Duration.hours(1),
      commit: Duration.minutes(5),
      create_pr: Duration.minutes(10),
      watch_pr_status_checks: Duration.minutes(5),
      resolve_pr_merge_conflict: Duration.hours(2),
      investigate_pr_status_checks: Duration.hours(2),
      mark_pr_ready_for_review: Duration.minutes(5),
      decide_pr_merge: Duration.minutes(15),
      merge_pr: Duration.minutes(5),
      close_issue: Duration.minutes(5),
      local_cleanup: Duration.minutes(5),
    },
    implementNow: unused,
    implementLocally: unused,
    implementAllWithAutoMerge: unused,
    queue: unused,
    recoverOrphanedStepRuns: Effect.succeed(0),
    interruptRunningStepRunsFromPriorWorker: Effect.succeed(0),
    runStep: unused,
    retry: unused,
    pause: unused,
    start: unused,
    abandon: unused,
    reset: unused,
    getWorkItem: unused,
    listWorkItemsForIssue: unused,
    listWorkItemsForRepository: unused,
    ownsSessionId: () => Effect.succeed(false),
    countCommittedPullRequests: unused,
    continueAfterHumanPrOutcome: unused,
    admitWaitingWorkItems: Effect.succeed(0),
    releaseWaitingForBlockers: () => Effect.succeed(0),
    ...lifecycleOverrides,
  }
  const readyRuntime = readyRuntimeStatus()
  const activeBackend: ActiveAgentBackendShape = {
    listStatuses: Effect.succeed([readyRuntime]),
    getBackendStatus: (backendId) =>
      Effect.succeed(
        backendId === readyRuntime.backend.id ? readyRuntime : null,
      ),
    getStatus: Effect.succeed(readyStatus()),
    setSelectedOrInUse: () => Effect.succeed([readyRuntime]),
    recheck: () => Effect.succeed(readyRuntime),
    requireAgentTurnsAllowed: () => Effect.void,
    activate: () => Effect.succeed(readyRuntime),
    drop: () => Effect.void,
    preview: () =>
      Effect.succeed({
        backend: { id: "opencode", label: "OpenCode" },
        kind: "ready" as const,
        reason: null,
        models: readyStatus().models,
      }),
    withConfigCoordination: (effect) => effect,
    getRegistration: () =>
      Effect.succeed({
        descriptor: { id: "opencode", label: "OpenCode" },
        capabilities: [
          { _tag: "SessionTelemetry", supported: true },
          { _tag: "KeymaxxerMcp", supported: true },
        ],
      }),
    getActiveRegistration: Effect.succeed({
      descriptor: { id: "opencode", label: "OpenCode" },
      capabilities: [
        { _tag: "SessionTelemetry", supported: true },
        { _tag: "KeymaxxerMcp", supported: true },
      ],
    }),
    startTurn: () => Effect.die("unused"),
    continueTurn: () => Effect.die("unused"),
    inspectBackend: () => Effect.die("unused"),
    getSessionTelemetry: (input) =>
      Effect.succeed(
        missingSessionTelemetry(input.sessionId ?? "", {
          id: "opencode",
          label: "OpenCode",
        }) satisfies SessionTelemetry,
      ),
    ...activeBackendOverrides,
  }
  const localGit = Layer.succeed(LocalGit, {
    inspect: (path) =>
      Effect.succeed({
        githubOwner: repository.githubOwner,
        githubRepo: repository.githubRepo,
        localPath: path,
        isBare: repository.isBare,
        paused: true as const,
      } satisfies LocalRepository),
    ...localGitOverrides,
  })
  const directoryPicker = Layer.succeed(DirectoryPicker, {
    available: Effect.succeed(false),
    pick: Effect.succeed(null),
  })
  return ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(KeymaxxerService, keymaxxer),
      Layer.succeed(ActiveAgentBackend, activeBackend),
      Layer.succeed(QueueService, queue),
      Layer.succeed(WorkItemLifecycle, lifecycle),
      Layer.succeed(GitHubService, {
        ...defaultGithub,
        ...githubOverrides,
      }),
      localGit,
      directoryPicker,
    ),
  )
}

const graphqlRequest = (body: unknown, origin?: string) =>
  new Request("http://127.0.0.1:6056/graphql", {
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

  test("suggests add repository command with npx when operator binary is not on PATH", async () => {
    const response = await createGraphqlApi(runtime, {
      commandExists: () => false,
    }).fetch(
      graphqlRequest({
        query: `query { addRepositoryCommand }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addRepositoryCommand: "npx ready-for-agent add /path/to/local/repo",
      },
    })
  })

  test("suggests add repository command without npx when operator binary is on PATH", async () => {
    const response = await createGraphqlApi(runtime, {
      commandExists: (command) => command === "ready-for-agent",
    }).fetch(
      graphqlRequest({
        query: `query { addRepositoryCommand }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addRepositoryCommand: "ready-for-agent add /path/to/local/repo",
      },
    })
  })

  test("reports directory picker availability from DirectoryPicker service", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { directoryPickerAvailable }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        directoryPickerAvailable: false,
      },
    })
  })

  test("addLocalRepository inspects then adds via DbService", async () => {
    let addedInput: {
      githubOwner: string
      githubRepo: string
      localPath: string
      isBare: boolean
    } | null = null
    const addRuntime = makeRuntime({
      addRepository: (input) => {
        addedInput = input
        return Effect.succeed({
          ...repository,
          githubOwner: input.githubOwner,
          githubRepo: input.githubRepo,
          localPath: input.localPath,
          isBare: input.isBare,
        })
      },
    })

    try {
      const response = await createGraphqlApi(addRuntime).fetch(
        graphqlRequest({
          query: `mutation AddLocal($path: String!) {
            addLocalRepository(path: $path) {
              id
              githubOwner
              githubRepo
              localPath
              isBare
            }
          }`,
          variables: { path: "/tmp/fixture-repo" },
        }),
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        data: {
          addLocalRepository: {
            id: repository.id,
            githubOwner: repository.githubOwner,
            githubRepo: repository.githubRepo,
            localPath: "/tmp/fixture-repo",
            isBare: repository.isBare,
          },
        },
      })
      expect(addedInput).toEqual({
        githubOwner: repository.githubOwner,
        githubRepo: repository.githubRepo,
        localPath: "/tmp/fixture-repo",
        isBare: repository.isBare,
      })
    } finally {
      await addRuntime.dispose()
    }
  })

  test("addLocalRepository rejects an empty path", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          addLocalRepository(path: "   ") { id }
        }`,
      }),
    )

    const body = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string }
      }>
    }
    expect(body.errors?.[0]?.message).toContain("Path is required")
    expect(body.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT")
  })

  test("addLocalRepository maps LocalGit inspect failures to GraphQL errors", async () => {
    const failRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {},
      {
        inspect: (path) => Effect.fail(new NotAGitRepository({ path })),
      },
    )
    try {
      const response = await createGraphqlApi(failRuntime).fetch(
        graphqlRequest({
          query: `mutation {
            addLocalRepository(path: "/tmp/not-a-repo") { id }
          }`,
        }),
      )
      const body = (await response.json()) as {
        errors?: ReadonlyArray<{
          message: string
          extensions?: { code?: string }
        }>
      }
      expect(body.errors?.[0]?.message).toContain("Not a git repository")
      expect(body.errors?.[0]?.extensions?.code).toBe("NOT_A_GIT_REPOSITORY")
    } finally {
      await failRuntime.dispose()
    }
  })

  test("pickLocalDirectory returns null when picker yields no path", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation { pickLocalDirectory }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        pickLocalDirectory: null,
      },
    })
  })

  test("activates Issue Polling when adding a repository that already has a GitHub token", async () => {
    const ensured: Array<{
      queue: string
      key: string
      payload: Record<string, unknown>
      delayMs: number
    }> = []
    const enqueued: Array<{
      queue: string
      payload: Record<string, unknown>
      retryLimit: number | undefined
    }> = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        findSecret: ({ account, provider }) =>
          Effect.succeed(
            provider === "github" &&
              account === `${repository.githubOwner}/${repository.githubRepo}`
              ? "GITHUB_TOKEN_ACME_WIDGETS"
              : null,
          ),
      },
      {
        ensureKeyed: (queueName, key, payload, delay) =>
          Effect.sync(() => {
            ensured.push({
              queue: queueName,
              key,
              payload,
              delayMs: Duration.toMillis(delay),
            })
            return { jobId: makeJobId(), created: true }
          }),
        enqueue: (queueName, payload, options) =>
          Effect.sync(() => {
            enqueued.push({
              queue: queueName,
              payload,
              retryLimit: options?.retryLimit,
            })
            return makeJobId()
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest(),
    )

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
    expect(ensured).toHaveLength(1)
    expect(ensured[0]?.queue).toBe("issue-poll")
    expect(ensured[0]?.key).toBe(repository.id)
    expect(ensured[0]?.payload).toEqual({
      _tag: "refresh-repository",
      repositoryId: repository.id,
    })
    expect(ensured[0]?.delayMs).toBeGreaterThanOrEqual(120_000)
    expect(ensured[0]?.delayMs).toBeLessThanOrEqual(150_000)
    expect(enqueued).toEqual([
      {
        queue: "issue-refresh",
        payload: {
          _tag: "refresh-repository",
          repositoryId: repository.id,
        },
        retryLimit: 1,
      },
    ])
  })

  test("activates Issue Polling with ambient GitHub authentication", async () => {
    let ensured = false
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        enabled: false,
        findSecret: () => Effect.die("must not inspect the vault"),
      },
      {
        ensureKeyed: () => {
          ensured = true
          return Effect.succeed({ jobId: makeJobId(), created: true })
        },
        enqueue: () => {
          enqueued = true
          return Effect.succeed(makeJobId())
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest(),
    )

    expect(response.status).toBe(200)
    expect((await response.json()).data.addRepository.id).toBe(repository.id)
    expect(ensured).toBe(true)
    expect(enqueued).toBe(true)
  })

  test("does not activate Issue Polling when adding a repository without a GitHub token", async () => {
    let ensured = false
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        findSecret: () => Effect.succeed(null),
      },
      {
        ensureKeyed: () => {
          ensured = true
          return Effect.succeed({ jobId: makeJobId(), created: true })
        },
        enqueue: () => {
          enqueued = true
          return Effect.succeed(makeJobId())
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest(),
    )

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
    expect(ensured).toBe(false)
    expect(enqueued).toBe(false)
  })

  test("keeps the added repository when automatic Issue Polling activation fails", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      },
      {
        ensureKeyed: () =>
          Effect.fail(
            new EnqueueError({
              queue: "issue-poll",
              message: "queue unavailable",
            }),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest(),
    )

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
      new Request("http://127.0.0.1:6056/graphql", {
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
            defaultThinkingLevel
            autoMerge
            includeAllIssueAuthors
            waitForReadyForReviewChecks
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
            defaultThinkingLevel: null,
            autoMerge: false,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: true,
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
    expect(creationUrl.searchParams.get("issues")).toBe("write")
    expect(creationUrl.searchParams.get("contents")).toBe("write")
    expect(creationUrl.searchParams.get("pull_requests")).toBe("write")
    expect(creationUrl.searchParams.get("actions")).toBe("write")
    expect(creationUrl.searchParams.get("statuses")).toBe("read")
    expect(creationUrl.searchParams.get("checks")).toBeNull()
  })

  test("reports ambient GitHub authentication as configured", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        enabled: false,
        findSecrets: () => Effect.die("must not inspect the vault"),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          repositoryCredentials { repositoryId configured }
        }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        repositoryCredentials: [
          { repositoryId: repository.id, configured: true },
        ],
      },
    })
  })

  test("opens Keymaxxer setup for a missing repository token", async () => {
    let tokenName: string | null = null
    let addCalls = 0
    let addedInput: Parameters<KeymaxxerServiceShape["addSecret"]>[0] | null =
      null
    const ensured: string[] = []
    const enqueued: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
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
      {
        ensureKeyed: (_queue, key) =>
          Effect.sync(() => {
            ensured.push(key)
            return { jobId: makeJobId(), created: true }
          }),
        enqueue: (_queue) =>
          Effect.sync(() => {
            enqueued.push("refresh")
            return makeJobId()
          }),
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
    // Concurrent requests share token provisioning; both may activate polling.
    expect(ensured.every((id) => id === repository.id)).toBe(true)
    expect(ensured.length).toBeGreaterThanOrEqual(1)
    expect(enqueued.length).toBeGreaterThanOrEqual(1)
  })

  test("rejects a saved token whose metadata no longer matches", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
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

  test("removes a repository and suspends Issue Polling", async () => {
    let removedRepositoryId: string | undefined
    let removeKeyedCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        removeRepository: (repositoryId) => {
          removedRepositoryId = repositoryId
          return Effect.void
        },
      },
      {},
      {
        removeKeyed: () =>
          Effect.sync(() => {
            removeKeyedCalls += 1
          }),
      },
    )

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
    expect(removeKeyedCalls).toBe(1)
  })

  test("resets a Work Item", async () => {
    const workItemId = makeWorkItemId()
    let resetWorkItemId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
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
        query: `query { config { selectedAgentBackend defaultModel defaultThinkingLevel reviewModel reviewThinkingLevel maxConcurrentAgentTurns maxConcurrentWorkItems } }`,
      }),
    )
    expect(await queryResponse.json()).toEqual({ data: { config } })

    const mutationResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) {
            selectedAgentBackend defaultModel defaultThinkingLevel reviewModel reviewThinkingLevel maxConcurrentAgentTurns maxConcurrentWorkItems
          }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: "anthropic/claude-opus-4-6",
            reviewThinkingLevel: "max",
            maxConcurrentAgentTurns: 3,
            maxConcurrentWorkItems: 7,
          },
        },
      }),
    )
    expect(await mutationResponse.json()).toEqual({
      data: {
        updateConfig: {
          selectedAgentBackend: "opencode",
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "high",
          reviewModel: "anthropic/claude-opus-4-6",
          reviewThinkingLevel: "max",
          maxConcurrentAgentTurns: 3,
          maxConcurrentWorkItems: 7,
        },
      },
    })
  })

  test("updateConfig syncs selected-or-in-use and moves proxy when default changes", async () => {
    const setSelectedCalls: string[][] = []
    const activated: string[] = []
    let proxyBackendId: AgentBackendId = "opencode"
    let selectedIds: AgentBackendId[] = ["opencode"]
    const activeIds = new Set<AgentBackendId>(["opencode"])

    const activateRuntime = makeRuntime(
      {
        updateConfig: (input) =>
          Effect.succeed({
            selectedAgentBackend: input.selectedAgentBackend,
            defaultModel: input.defaultModel,
            defaultThinkingLevel: input.defaultThinkingLevel,
            reviewModel: input.reviewModel,
            reviewThinkingLevel: input.reviewThinkingLevel,
            maxConcurrentAgentTurns: input.maxConcurrentAgentTurns,
            maxConcurrentWorkItems: input.maxConcurrentWorkItems,
          }),
        listSelectedOrInUseBackendIds: Effect.sync(() => selectedIds),
      },
      {},
      {},
      {},
      {
        getBackendStatus: (backendId) =>
          Effect.succeed(
            activeIds.has(backendId)
              ? readyRuntimeStatus(defaultModels, backendId)
              : null,
          ),
        getStatus: Effect.sync(() =>
          toAgentBackendStatus(
            readyRuntimeStatus(defaultModels, proxyBackendId),
          ),
        ),
        setSelectedOrInUse: (backendIds) => {
          setSelectedCalls.push([...backendIds])
          for (const id of backendIds) {
            activeIds.add(id)
          }
          for (const id of [...activeIds]) {
            if (!backendIds.includes(id)) {
              activeIds.delete(id)
            }
          }
          return Effect.succeed(
            backendIds.map((id) => readyRuntimeStatus(defaultModels, id)),
          )
        },
        activate: (backendId) => {
          activated.push(backendId)
          activeIds.add(backendId)
          proxyBackendId = backendId
          return Effect.succeed(readyRuntimeStatus(defaultModels, backendId))
        },
      },
    )

    selectedIds = ["grok"]
    const switchResponse = await createGraphqlApi(activateRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { selectedAgentBackend }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "grok",
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await switchResponse.json()).toEqual({
      data: { updateConfig: { selectedAgentBackend: "grok" } },
    })
    expect(setSelectedCalls).toEqual([["grok"]])
    expect(activated).toEqual(["grok"])

    // Switch back to still-Active prior backend must activate to move proxy.
    setSelectedCalls.length = 0
    activated.length = 0
    selectedIds = ["opencode", "grok"]
    const switchBack = await createGraphqlApi(activateRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { selectedAgentBackend }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await switchBack.json()).toEqual({
      data: { updateConfig: { selectedAgentBackend: "opencode" } },
    })
    expect(setSelectedCalls).toEqual([["opencode", "grok"]])
    expect(activated).toEqual(["opencode"])

    // Same-backend save with proxy already correct skips activate (setSelected
    // still runs; registry same-backend members skip re-inspect).
    setSelectedCalls.length = 0
    activated.length = 0
    selectedIds = ["opencode", "grok"]
    const sameBackend = await createGraphqlApi(activateRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { selectedAgentBackend }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await sameBackend.json()).toEqual({
      data: { updateConfig: { selectedAgentBackend: "opencode" } },
    })
    expect(setSelectedCalls).toEqual([["opencode", "grok"]])
    expect(activated).toEqual([])
  })

  test("updates repository settings including backend override set and clear", async () => {
    const settingsCalls: Array<{
      selectedAgentBackend?: string | null
    }> = []
    const setSelectedCalls: string[][] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {
        updateRepositorySettings: (input) => {
          settingsCalls.push({
            selectedAgentBackend: input.selectedAgentBackend,
          })
          return Effect.succeed({
            ...repository,
            paused: input.paused,
            selectedAgentBackend:
              input.selectedAgentBackend === undefined
                ? repository.selectedAgentBackend
                : input.selectedAgentBackend,
            defaultModel: input.defaultModel,
            defaultThinkingLevel: input.defaultThinkingLevel,
            reviewModel: input.reviewModel,
            reviewThinkingLevel: input.reviewThinkingLevel,
            autoMerge: input.autoMerge,
            includeAllIssueAuthors: input.includeAllIssueAuthors,
            waitForReadyForReviewChecks: input.waitForReadyForReviewChecks,
          })
        },
        listSelectedOrInUseBackendIds: Effect.succeed(["opencode", "grok"]),
      },
      {},
      {},
      {},
      {
        setSelectedOrInUse: (backendIds) => {
          setSelectedCalls.push([...backendIds])
          return Effect.succeed(
            backendIds.map((id) => readyRuntimeStatus(defaultModels, id)),
          )
        },
      },
    )

    const setOverride = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            id
            paused
            selectedAgentBackend
            defaultModel
            defaultThinkingLevel
            reviewModel
            reviewThinkingLevel
            autoMerge
            includeAllIssueAuthors
            waitForReadyForReviewChecks
          }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: "grok",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: "anthropic/claude-opus-4-6",
            reviewThinkingLevel: "max",
            autoMerge: true,
            includeAllIssueAuthors: true,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    expect(await setOverride.json()).toEqual({
      data: {
        updateRepositorySettings: {
          id: repository.id,
          paused: false,
          selectedAgentBackend: "grok",
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "high",
          reviewModel: "anthropic/claude-opus-4-6",
          reviewThinkingLevel: "max",
          autoMerge: true,
          includeAllIssueAuthors: true,
          waitForReadyForReviewChecks: false,
        },
      },
    })
    expect(settingsCalls[0]).toEqual({ selectedAgentBackend: "grok" })
    expect(setSelectedCalls).toEqual([["opencode", "grok"]])

    // Clear override (null) inherits harness default.
    settingsCalls.length = 0
    setSelectedCalls.length = 0
    const clearOverride = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            selectedAgentBackend
          }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: false,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: true,
          },
        },
      }),
    )
    expect(await clearOverride.json()).toEqual({
      data: {
        updateRepositorySettings: {
          selectedAgentBackend: null,
        },
      },
    })
    expect(settingsCalls[0]).toEqual({ selectedAgentBackend: null })

    // Omit selectedAgentBackend leaves override unchanged (undefined to DbService).
    settingsCalls.length = 0
    const omitOverride = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            selectedAgentBackend
          }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: false,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: true,
          },
        },
      }),
    )
    expect(await omitOverride.json()).toEqual({
      data: {
        updateRepositorySettings: {
          selectedAgentBackend: null,
        },
      },
    })
    expect(settingsCalls[0]).toEqual({ selectedAgentBackend: undefined })
  })

  test("exposes scoped gate counts on Config and Repository", async () => {
    await runtime.dispose()
    const counted: Array<{ owner: string; name: string }> = []
    runtime = makeRuntime(
      {
        countUnfinishedWorkItems: Effect.succeed(3),
        countBlockingUnfinishedForGlobalDefault: Effect.succeed(1),
        countBlockingUnfinishedForRepository: (repositoryId) =>
          Effect.succeed(repositoryId === repository.id ? 2 : 0),
        listRepositories: Effect.succeed([
          makeRepositoryRecord({
            id: repository.id,
            selectedAgentBackend: "grok",
          }),
        ]),
      },
      {},
      {},
      {},
      {},
      {},
      {
        countOpenNonDraftPullRequests: (repo) => {
          counted.push(repo)
          return Effect.succeed(7)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query GateCounts {
          config {
            unfinishedWorkItemCount
            blockingUnfinishedWorkItemCount
          }
          repositories {
            id
            selectedAgentBackend
            effectiveAgentBackend
            blockingUnfinishedWorkItemCount
            pullRequestCount
          }
        }`,
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        config: {
          unfinishedWorkItemCount: 3,
          blockingUnfinishedWorkItemCount: 1,
        },
        repositories: [
          {
            id: repository.id,
            selectedAgentBackend: "grok",
            effectiveAgentBackend: "grok",
            blockingUnfinishedWorkItemCount: 2,
            pullRequestCount: 7,
          },
        ],
      },
    })
    expect(counted).toEqual([
      { owner: repository.githubOwner, name: repository.githubRepo },
    ])
  })

  test("pullRequestCount uses GitHub open non-draft PRs including external ones", async () => {
    await runtime.dispose()
    let openNonDraft = 1
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([repository]),
      },
      {},
      {},
      {},
      {},
      {},
      {
        countOpenNonDraftPullRequests: () => Effect.succeed(openNonDraft),
      },
    )

    const query = {
      query: `query {
        repositories { id pullRequestCount }
      }`,
    }

    const first = await createGraphqlApi(runtime).fetch(graphqlRequest(query))
    expect(await first.json()).toEqual({
      data: { repositories: [{ id: repository.id, pullRequestCount: 1 }] },
    })

    // Draft → ready and external open PRs are reflected via GitHub count.
    openNonDraft = 3
    const second = await createGraphqlApi(runtime).fetch(graphqlRequest(query))
    expect(await second.json()).toEqual({
      data: { repositories: [{ id: repository.id, pullRequestCount: 3 }] },
    })

    openNonDraft = 0
    const third = await createGraphqlApi(runtime).fetch(graphqlRequest(query))
    expect(await third.json()).toEqual({
      data: { repositories: [{ id: repository.id, pullRequestCount: 0 }] },
    })
  })

  test("pullRequestCount degrades to zero when GitHub is unavailable", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([repository]),
      },
      {},
      {},
      {},
      {},
      {},
      {
        countOpenNonDraftPullRequests: (repo) =>
          Effect.fail(new GitHubRepositoryUnavailableError(repo)),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { repositories { pullRequestCount } }`,
      }),
    )
    expect(await response.json()).toEqual({
      data: { repositories: [{ pullRequestCount: 0 }] },
    })
  })

  test("lists multi-backend status and rechecks by backend id", async () => {
    const rechecked: string[] = []
    const opencodeStatus = readyRuntimeStatus(defaultModels, "opencode")
    const grokStatus = readyRuntimeStatus(
      [{ id: "grok-code", thinkingLevels: [] }],
      "grok",
    )
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        listStatuses: Effect.succeed([opencodeStatus, grokStatus]),
        recheck: (backendId) => {
          rechecked.push(backendId)
          return Effect.succeed(
            backendId === "grok" ? grokStatus : opencodeStatus,
          )
        },
      },
    )

    const listResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          agentBackendStatuses {
            backend { id label }
            kind
            reason
            models { id }
          }
        }`,
      }),
    )
    expect(await listResponse.json()).toEqual({
      data: {
        agentBackendStatuses: [
          {
            backend: { id: "opencode", label: "OpenCode" },
            kind: "READY",
            reason: null,
            models: defaultModels.map((m) => ({ id: m.id })),
          },
          {
            backend: { id: "grok", label: "grok" },
            kind: "READY",
            reason: null,
            models: [{ id: "grok-code" }],
          },
        ],
      },
    })

    const recheckResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          recheckAgentBackend(backendId: "grok") {
            backend { id }
            kind
            models { id }
          }
        }`,
      }),
    )
    expect(await recheckResponse.json()).toEqual({
      data: {
        recheckAgentBackend: {
          backend: { id: "grok" },
          kind: "READY",
          models: [{ id: "grok-code" }],
        },
      },
    })
    expect(rechecked).toEqual(["grok"])
  })

  test("rejects invalid backend id on recheck and surfaces repository settings rejection", async () => {
    const { InvalidRepositorySettingsError } = await import(
      "@ready-for-agent/db-service"
    )
    await runtime.dispose()
    runtime = makeRuntime({
      updateRepositorySettings: () =>
        Effect.fail(
          new InvalidRepositorySettingsError({
            field: "selectedAgentBackend",
            message: "Unknown Agent Backend: not-a-backend",
          }),
        ),
    })

    const invalidRecheck = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          recheckAgentBackend(backendId: "not-a-backend") {
            backend { id }
            kind
            reason
            models { id }
          }
        }`,
      }),
    )
    expect(await invalidRecheck.json()).toEqual({
      data: {
        recheckAgentBackend: {
          backend: { id: "not-a-backend" },
          kind: "UNAVAILABLE",
          reason: "Unknown Agent Backend: not-a-backend",
          models: [],
        },
      },
    })

    const whitespaceRecheck = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          recheckAgentBackend(backendId: "   ") {
            backend { id }
            kind
            reason
            models { id }
          }
        }`,
      }),
    )
    expect(await whitespaceRecheck.json()).toEqual({
      data: {
        recheckAgentBackend: {
          backend: { id: "   " },
          kind: "UNAVAILABLE",
          reason: "Unknown Agent Backend:    ",
          models: [],
        },
      },
    })

    const invalidSettings = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { id }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: "not-a-backend",
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: false,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: true,
          },
        },
      }),
    )
    expect(await invalidSettings.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "Unknown Agent Backend: not-a-backend",
          extensions: expect.objectContaining({
            code: "INVALID_REPOSITORY_SETTINGS",
            field: "selectedAgentBackend",
          }),
        }),
      ],
    })
  })

  test("surfaces Implement Now errors for unavailable backend and missing build model", async () => {
    const { AgentBackendUnavailableError, BuildModelNotConfiguredError } =
      await import("@ready-for-agent/work-item-lifecycle")

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.fail(
            new AgentBackendUnavailableError({
              message: "Agent Backend is unavailable",
              reason: "CLI missing",
            }),
          ),
      },
    )
    const unavailable = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )
    expect(await unavailable.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "Agent Backend is unavailable",
          extensions: expect.objectContaining({
            code: "AGENT_BACKEND_UNAVAILABLE",
            reason: "CLI missing",
          }),
        }),
      ],
    })

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.fail(
            new BuildModelNotConfiguredError({
              message: "Select a default build model first",
            }),
          ),
      },
    )
    const missingModel = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )
    expect(await missingModel.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "Select a default build model first",
          extensions: expect.objectContaining({
            code: "BUILD_MODEL_NOT_CONFIGURED",
          }),
        }),
      ],
    })
  })

  test("pauses and unpauses a repository", async () => {
    await runtime.dispose()
    runtime = makeRuntime({
      pauseRepository: (repositoryId) =>
        Effect.succeed({
          ...repository,
          id: repositoryId,
          paused: true,
        }),
      unpauseRepository: (repositoryId) =>
        Effect.succeed({
          ...repository,
          id: repositoryId,
          paused: false,
        }),
    })

    const api = createGraphqlApi(runtime)
    const paused = await api.fetch(
      graphqlRequest({
        query: `mutation PauseRepository($repositoryId: ID!) {
          pauseRepository(repositoryId: $repositoryId) {
            id
            paused
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )
    expect(await paused.json()).toEqual({
      data: {
        pauseRepository: {
          id: repository.id,
          paused: true,
        },
      },
    })

    const unpaused = await api.fetch(
      graphqlRequest({
        query: `mutation UnpauseRepository($repositoryId: ID!) {
          unpauseRepository(repositoryId: $repositoryId) {
            id
            paused
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )
    expect(await unpaused.json()).toEqual({
      data: {
        unpauseRepository: {
          id: repository.id,
          paused: false,
        },
      },
    })
  })

  test("lists models from Active Agent Backend status", async () => {
    let statusCount = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () =>
          Effect.sync(() => {
            statusCount += 1
            return readyRuntimeStatus()
          }),
      },
    )

    const api = createGraphqlApi(runtime)
    const first = await api.fetch(
      graphqlRequest({
        query: `query { models { id thinkingLevels } }`,
      }),
    )
    const second = await api.fetch(
      graphqlRequest({
        query: `query { models { id thinkingLevels } }`,
      }),
    )

    expect(await first.json()).toEqual({
      data: {
        models: [
          {
            id: "opencode/deepseek-v4-flash-free",
            thinkingLevels: ["high", "max"],
          },
          {
            id: "anthropic/claude-sonnet-4-5",
            thinkingLevels: ["low", "medium", "high", "max"],
          },
        ],
      },
    })
    expect(await second.json()).toEqual({
      data: {
        models: [
          {
            id: "opencode/deepseek-v4-flash-free",
            thinkingLevels: ["high", "max"],
          },
          {
            id: "anthropic/claude-sonnet-4-5",
            thinkingLevels: ["low", "medium", "high", "max"],
          },
        ],
      },
    })
    expect(statusCount).toBe(2)
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
            issueAuthor
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
            issueAuthor: issue.issueAuthor,
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
          { githubIssueNumber: 3, hasChildren: false, parent: null },
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
            id state stateLabel status statusLabel statusMessage paused canRetry isTerminal
            stateReadyAt createdAt updatedAt
            lifecycleLabels { phase label status durationMs }
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
            stateLabel: "Create worktree",
            status: "RUNNING",
            statusLabel: "Running",
            statusMessage: null,
            paused: false,
            canRetry: false,
            isTerminal: false,
            stateReadyAt: "2026-07-14T08:00:00.000Z",
            createdAt: "2026-07-14T08:00:00.000Z",
            updatedAt: "2026-07-14T08:00:01.000Z",
            lifecycleLabels: [
              {
                phase: "CREATE_WORKTREE",
                label: "Create worktree: Running",
                status: "RUNNING",
                durationMs: 250,
              },
            ],
          },
        ],
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("serializes local_cleanup as a lifecycle phase", async () => {
    const baseRun = workItem.stepRuns[0]!
    const cleanedUp = {
      ...workItem,
      state: "complete",
      stepRuns: [
        { ...baseRun, step: "merge_pr", status: "succeeded" },
        { ...baseRun, step: "local_cleanup", status: "succeeded" },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([cleanedUp]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            state lifecycleLabels { phase label status }
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
            state: "COMPLETE",
            lifecycleLabels: [
              {
                phase: "MERGE_PR",
                label: "Merge PR: Merged",
                status: "SUCCEEDED",
              },
              {
                phase: "LOCAL_CLEANUP",
                label: "Local cleanup: Succeeded",
                status: "SUCCEEDED",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects repeated status-check runs as one lifecycle phase", async () => {
    const baseRun = workItem.stepRuns[0]!
    const polling = {
      ...workItem,
      state: "watch_pr_status_checks",
      stepRuns: [
        { ...baseRun, step: "implement", status: "succeeded" },
        { ...baseRun, step: "review", status: "failed" },
        { ...baseRun, step: "review", status: "succeeded" },
        {
          ...baseRun,
          step: "resolve_pr_merge_conflict",
          status: "succeeded",
        },
        { ...baseRun, step: "watch_pr_status_checks", status: "succeeded" },
        {
          ...baseRun,
          step: "investigate_pr_status_checks",
          status: "succeeded",
        },
        { ...baseRun, step: "watch_pr_status_checks", status: "queued" },
      ],
    } as WorkItemRecord
    const needsHuman = {
      ...polling,
      id: makeWorkItemId(),
      state: "needs_human",
      failureMessage: "The pull request was closed",
      stepRuns: [
        {
          ...baseRun,
          step: "investigate_pr_status_checks",
          status: "succeeded",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([polling, needsHuman]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage canRetry isTerminal
            lifecycleLabels { phase label status }
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
            stateLabel: "GitHub status checks",
            status: "QUEUED",
            statusLabel: "Queued",
            statusMessage: null,
            canRetry: false,
            isTerminal: false,
            lifecycleLabels: [
              {
                phase: "IMPLEMENT",
                label: "Build: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "REVIEW",
                label: "Review: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "RESOLVE_PR_MERGE_CONFLICT",
                label: "Resolve PR merge conflict: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "GITHUB_STATUS_CHECKS",
                label: "GitHub status checks: Queued",
                status: "QUEUED",
              },
            ],
          },
          {
            stateLabel: "Needs human",
            status: "NEEDS_HUMAN",
            statusLabel: "Needs human",
            statusMessage: "The pull request was closed",
            canRetry: true,
            isTerminal: true,
            lifecycleLabels: [
              {
                phase: "GITHUB_STATUS_CHECKS",
                label: "GitHub status checks: Needs human",
                status: "NEEDS_HUMAN",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects paused Implement Locally work item as Needs human review", async () => {
    const baseRun = workItem.stepRuns[0]!
    const pausedAtCommit = {
      ...workItem,
      state: "commit",
      paused: true,
      pauseBeforeStep: "commit",
      stepRuns: [
        { ...baseRun, step: "create_worktree", status: "succeeded" },
        { ...baseRun, step: "install_dependencies", status: "succeeded" },
        { ...baseRun, step: "implement", status: "succeeded" },
        { ...baseRun, step: "pre_commit", status: "succeeded" },
        { ...baseRun, step: "review", status: "succeeded" },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([pausedAtCommit]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            state stateLabel status statusLabel paused isTerminal
            lifecycleLabels { phase label status }
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
            state: "COMMIT",
            stateLabel: "Commit",
            status: "NEEDS_HUMAN_REVIEW",
            statusLabel: "Needs human review",
            paused: true,
            isTerminal: false,
            lifecycleLabels: [
              {
                phase: "CREATE_WORKTREE",
                label: "Create worktree: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "INSTALL_DEPENDENCIES",
                label: "Install dependencies: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "IMPLEMENT",
                label: "Build: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "PRE_COMMIT",
                label: "Pre commit: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "REVIEW",
                label: "Review: Succeeded",
                status: "SUCCEEDED",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects operator-paused unfinished work item as Needs human review", async () => {
    const baseRun = workItem.stepRuns[0]!
    const operatorPaused = {
      ...workItem,
      state: "implement",
      paused: true,
      pauseBeforeStep: null,
      stepRuns: [
        { ...baseRun, step: "create_worktree", status: "succeeded" },
        { ...baseRun, step: "install_dependencies", status: "succeeded" },
        { ...baseRun, step: "implement", status: "succeeded" },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([operatorPaused]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            state status statusLabel paused isTerminal
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
            state: "IMPLEMENT",
            status: "NEEDS_HUMAN_REVIEW",
            statusLabel: "Needs human review",
            paused: true,
            isTerminal: false,
          },
        ],
      },
    })
  })

  test("keeps terminal Needs human distinct from paused Needs human review", async () => {
    const baseRun = workItem.stepRuns[0]!
    const needsHuman = {
      ...workItem,
      state: "needs_human",
      paused: false,
      failureMessage: "Human must approve merge",
      stepRuns: [
        {
          ...baseRun,
          step: "decide_pr_merge",
          status: "succeeded",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([needsHuman]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            state status statusLabel statusMessage paused isTerminal
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
            state: "NEEDS_HUMAN",
            status: "NEEDS_HUMAN",
            statusLabel: "Needs human",
            statusMessage: "Human must approve merge",
            paused: false,
            isTerminal: true,
          },
        ],
      },
    })
  })

  test("projects running Step Run waiting for OpenCode session as Queued", async () => {
    const baseRun = workItem.stepRuns[0]!
    const waiting = {
      ...workItem,
      state: "implement",
      stepRuns: [
        {
          ...baseRun,
          step: "implement",
          status: "running",
          reasonCode: STEP_RUN_REASON.waitingForAgentTurn,
          reasonMessage: WAITING_FOR_AGENT_TURN_MESSAGE,
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([waiting]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
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
            stateLabel: "Build",
            status: "QUEUED",
            statusLabel: "Queued",
            statusMessage: WAITING_FOR_AGENT_TURN_MESSAGE,
            lifecycleLabels: [
              {
                phase: "IMPLEMENT",
                label: "Build: Queued",
                status: "QUEUED",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects running Review Step Run as Review: reviewing", async () => {
    const baseRun = workItem.stepRuns[0]!
    const reviewing = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "running",
          reasonCode: STEP_RUN_REASON.reviewReviewing,
          reasonMessage: "reviewing",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([reviewing]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
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
            stateLabel: "Review",
            status: "RUNNING",
            statusLabel: "Running",
            statusMessage: null,
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: reviewing",
                status: "RUNNING",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects running Review Step Run as Review: applying findings", async () => {
    const baseRun = workItem.stepRuns[0]!
    const applying = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "running",
          reasonCode: STEP_RUN_REASON.reviewApplyingFindings,
          reasonMessage: "applying findings",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([applying]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
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
            stateLabel: "Review",
            status: "RUNNING",
            statusLabel: "Running",
            statusMessage: null,
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: applying findings",
                status: "RUNNING",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects running Review Step Run as Review: pre-commit", async () => {
    const baseRun = workItem.stepRuns[0]!
    const preCommitPhase = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "running",
          reasonCode: STEP_RUN_REASON.reviewPreCommit,
          reasonMessage: "pre-commit",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([preCommitPhase]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
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
            stateLabel: "Review",
            status: "RUNNING",
            statusLabel: "Running",
            statusMessage: null,
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: pre-commit",
                status: "RUNNING",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects running Review Step Run as Review: assessing rerun", async () => {
    const baseRun = workItem.stepRuns[0]!
    const assessing = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "running",
          reasonCode: STEP_RUN_REASON.reviewAssessingRerun,
          reasonMessage: "assessing rerun",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([assessing]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
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
            stateLabel: "Review",
            status: "RUNNING",
            statusLabel: "Running",
            statusMessage: null,
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: assessing rerun",
                status: "RUNNING",
              },
            ],
          },
        ],
      },
    })
  })

  test("keeps non-echo Review statusMessage while Review phase reasonCode is set", async () => {
    const baseRun = workItem.stepRuns[0]!
    const operational = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "running",
          reasonCode: STEP_RUN_REASON.reviewReviewing,
          reasonMessage: "waiting on model response",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([operational]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            status statusMessage
            lifecycleLabels { phase label status }
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
            status: "RUNNING",
            statusMessage: "waiting on model response",
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: reviewing",
                status: "RUNNING",
              },
            ],
          },
        ],
      },
    })
  })

  test("keeps failed Review reasonMessage as statusMessage", async () => {
    const baseRun = workItem.stepRuns[0]!
    const failedReview = {
      ...workItem,
      state: "review",
      stepRuns: [
        {
          ...baseRun,
          step: "review",
          status: "failed",
          reasonCode: STEP_RUN_REASON.handlerFailed,
          reasonMessage: "OpenCode failed to review the Work Item",
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([failedReview]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            status statusMessage
            lifecycleLabels { phase label status }
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
            status: "FAILED",
            statusMessage: "OpenCode failed to review the Work Item",
            lifecycleLabels: [
              {
                phase: "REVIEW",
                label: "Review: Failed",
                status: "FAILED",
              },
            ],
          },
        ],
      },
    })
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

  test("exposes Work Item PR number when recorded", async () => {
    const withPr = {
      ...workItem,
      githubPullRequestNumber: 212,
    } as WorkItemRecord
    const withoutPr = {
      ...workItem,
      id: makeWorkItemId(),
      githubPullRequestNumber: null,
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([withPr, withoutPr]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!) {
          workItems(repositoryId: $repositoryId) {
            id githubPullRequestNumber
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: withPr.id,
            githubPullRequestNumber: 212,
          },
          {
            id: withoutPr.id,
            githubPullRequestNumber: null,
          },
        ],
      },
    })
  })

  test("shows Working Work Items after their Issues leave the Issue store", async () => {
    const needsHuman = {
      ...workItem,
      id: makeWorkItemId(),
      state: "needs_human" as const,
      stepRuns: [],
    }
    const retryableNeedsHuman = {
      ...needsHuman,
      id: makeWorkItemId(),
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          step: "investigate_pr_status_checks" as const,
          status: "succeeded" as const,
          finishedAt: new Date("2026-07-14T08:00:02.000Z"),
        },
      ],
    }
    const retryableReviewNeedsHuman = {
      ...needsHuman,
      id: makeWorkItemId(),
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          step: "review" as const,
          status: "succeeded" as const,
          finishedAt: new Date("2026-07-14T08:00:03.000Z"),
        },
      ],
    }
    const complete = {
      ...workItem,
      id: makeWorkItemId(),
      state: "complete" as const,
      stepRuns: [],
    }
    const implementing = {
      ...workItem,
      id: makeWorkItemId(),
      state: "implement" as const,
      stepRuns: [],
    }
    const retriableFailed = {
      ...workItem,
      id: makeWorkItemId(),
      state: "implement" as const,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed" as const,
          finishedAt: new Date("2026-07-14T08:00:02.000Z"),
          reasonCode: "handler_failed",
          reasonMessage: "boom",
        },
      ],
    }
    const terminalFailed = {
      ...workItem,
      id: makeWorkItemId(),
      state: "failed" as const,
      stepRuns: [],
    }
    const recoverableTerminalFailed = {
      ...terminalFailed,
      id: makeWorkItemId(),
      failureCode: "pr_status_checks_unresolved",
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([
            needsHuman,
            retryableNeedsHuman,
            retryableReviewNeedsHuman,
            complete,
            implementing,
            retriableFailed,
            terminalFailed,
            recoverableTerminalFailed,
          ]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $listKind: WorkItemsListKind) {
          workItems(repositoryId: $repositoryId, listKind: $listKind) {
            id state canRetry isTerminal
          }
        }`,
        variables: { repositoryId: repository.id, listKind: "WORKING" },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: needsHuman.id,
            state: "NEEDS_HUMAN",
            canRetry: false,
            isTerminal: true,
          },
          {
            id: retryableNeedsHuman.id,
            state: "NEEDS_HUMAN",
            canRetry: true,
            isTerminal: true,
          },
          {
            id: retryableReviewNeedsHuman.id,
            state: "NEEDS_HUMAN",
            canRetry: true,
            isTerminal: true,
          },
          {
            id: implementing.id,
            state: "IMPLEMENT",
            canRetry: false,
            isTerminal: false,
          },
          {
            id: retriableFailed.id,
            state: "IMPLEMENT",
            canRetry: true,
            isTerminal: false,
          },
          {
            id: recoverableTerminalFailed.id,
            state: "FAILED",
            canRetry: true,
            isTerminal: true,
          },
        ],
      },
    })
  })

  test("filters Completed Work Items newest-first with limit", async () => {
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z")
    const completed = Array.from({ length: 18 }, (_, index) => ({
      ...workItem,
      id: makeWorkItemId(),
      state: (index % 2 === 0 ? "complete" : "abandoned") as
        | "complete"
        | "abandoned",
      createdAt: new Date(baseTime + index * 1000),
      stepRuns: [],
    }))
    const needsHuman = {
      ...workItem,
      id: makeWorkItemId(),
      state: "needs_human" as const,
      createdAt: new Date(baseTime + 50_000),
      stepRuns: [],
    }
    const terminalFailed = {
      ...workItem,
      id: makeWorkItemId(),
      state: "failed" as const,
      createdAt: new Date(baseTime + 40_000),
      stepRuns: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([...completed, needsHuman, terminalFailed]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $listKind: WorkItemsListKind, $limit: Int) {
          workItems(repositoryId: $repositoryId, listKind: $listKind, limit: $limit) {
            id state
          }
        }`,
        variables: {
          repositoryId: repository.id,
          listKind: "COMPLETED",
          limit: 15,
        },
      }),
    )

    const body = (await response.json()) as {
      data: { workItems: readonly { id: string; state: string }[] }
    }
    expect(body.data.workItems).toHaveLength(15)
    expect(
      body.data.workItems.every(
        (item) => item.state !== "NEEDS_HUMAN" && item.state !== "FAILED",
      ),
    ).toBe(true)
    expect(body.data.workItems.map((item) => item.id)).toEqual(
      completed
        .slice()
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )
        .slice(0, 15)
        .map((item) => item.id),
    )
  })

  test("filters Failed Work Items to non-retryable terminal failures", async () => {
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z")
    const retriableId = makeWorkItemId()
    const terminalFailedId = makeWorkItemId()
    const failedStep = {
      id: "srun-01J00000000000000000000FAIL",
      workItemId: retriableId,
      step: "implement" as const,
      status: "failed" as const,
      queueJobId: null,
      queuedAt: new Date(baseTime),
      startedAt: new Date(baseTime + 1),
      finishedAt: new Date(baseTime + 2),
      reasonCode: "handler_failed",
      reasonMessage: "boom",
      queueWaitMs: 1,
      executionDurationMs: 1,
    }
    const retriable = {
      ...workItem,
      id: retriableId,
      state: "implement" as const,
      createdAt: new Date(baseTime + 1000),
      stepRuns: [failedStep],
    }
    const terminalFailed = {
      ...workItem,
      id: terminalFailedId,
      state: "failed" as const,
      failureCode: "issue_not_open",
      failureMessage: "Issue is no longer open",
      createdAt: new Date(baseTime + 2000),
      stepRuns: [
        {
          ...failedStep,
          id: "srun-01J0000000000000000000TERM",
          workItemId: terminalFailedId,
          status: "succeeded" as const,
          reasonCode: null,
          reasonMessage: null,
        },
      ],
    }
    const complete = {
      ...workItem,
      id: makeWorkItemId(),
      state: "complete" as const,
      createdAt: new Date(baseTime + 3000),
      stepRuns: [],
    }
    const runningId = makeWorkItemId()
    const running = {
      ...workItem,
      id: runningId,
      state: "implement" as const,
      createdAt: new Date(baseTime + 4000),
      stepRuns: [
        {
          ...failedStep,
          id: "srun-01J0000000000000000000RUNN",
          workItemId: runningId,
          status: "running" as const,
          finishedAt: null,
          reasonCode: null,
          reasonMessage: null,
        },
      ],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([retriable, terminalFailed, complete, running]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $listKind: WorkItemsListKind) {
          workItems(repositoryId: $repositoryId, listKind: $listKind) {
            id state canRetry isTerminal
          }
        }`,
        variables: { repositoryId: repository.id, listKind: "FAILED" },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: terminalFailed.id,
            state: "FAILED",
            canRetry: false,
            isTerminal: true,
          },
        ],
      },
    })
  })

  test("keeps Working Work Items whose Issue is no longer Relevant", async () => {
    const needsHumanOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 120,
      state: "needs_human" as const,
      stepRuns: [],
    }
    const failedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 122,
      state: "failed" as const,
      stepRuns: [],
    }
    const unfinishedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 121,
      state: "implement" as const,
      stepRuns: [],
    }
    const completeOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 123,
      state: "complete" as const,
      stepRuns: [],
    }
    const abandonedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 124,
      state: "abandoned" as const,
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
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([
            needsHumanOrphan,
            failedOrphan,
            unfinishedOrphan,
            completeOrphan,
            abandonedOrphan,
            terminalRelevant,
          ]),
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
            id: needsHumanOrphan.id,
            githubIssueNumber: 120,
            state: "NEEDS_HUMAN",
          },
          {
            id: unfinishedOrphan.id,
            githubIssueNumber: 121,
            state: "IMPLEMENT",
          },
          {
            id: completeOrphan.id,
            githubIssueNumber: 123,
            state: "COMPLETE",
          },
          {
            id: abandonedOrphan.id,
            githubIssueNumber: 124,
            state: "ABANDONED",
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

  test("keeps complete and abandoned Work Items in COMPLETED when Issue is absent", async () => {
    const completeOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 201,
      issueTitle: "Completed issue title",
      state: "complete" as const,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      stepRuns: [],
    }
    const abandonedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 202,
      issueTitle: null,
      state: "abandoned" as const,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      stepRuns: [],
    }
    const failedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      githubIssueNumber: 203,
      state: "failed" as const,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      stepRuns: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([completeOrphan, abandonedOrphan, failedOrphan]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $listKind: WorkItemsListKind) {
          workItems(repositoryId: $repositoryId, listKind: $listKind) {
            id githubIssueNumber issueTitle state
          }
        }`,
        variables: { repositoryId: repository.id, listKind: "COMPLETED" },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: abandonedOrphan.id,
            githubIssueNumber: 202,
            issueTitle: null,
            state: "ABANDONED",
          },
          {
            id: completeOrphan.id,
            githubIssueNumber: 201,
            issueTitle: "Completed issue title",
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
            lifecycleLabels { phase label status }
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
          lifecycleLabels: [
            {
              phase: "CREATE_WORKTREE",
              label: "Create worktree: Running",
              status: "RUNNING",
            },
          ],
        },
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("starts a Work Item for Implement Locally", async () => {
    let receivedArgs: readonly [string, number] | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementLocally: (repositoryId, githubIssueNumber) => {
          receivedArgs = [repositoryId, githubIssueNumber]
          return Effect.succeed(workItem)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementLocally($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementLocally(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id state
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
        implementLocally: {
          id: workItem.id,
          state: "CREATE_WORKTREE",
        },
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("implements all with auto-merge for a Parent Issue's covered children", async () => {
    let receivedArgs: readonly [string, number] | undefined
    const actionableChild = {
      ...workItem,
      id: makeWorkItemId(),
      mergeMode: "always" as const,
      githubIssueNumber: 43,
    }
    const blockedChild = {
      ...workItem,
      id: makeWorkItemId(),
      mergeMode: "always" as const,
      githubIssueNumber: 44,
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      stepRuns: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementAllWithAutoMerge: (repositoryId, githubIssueNumber) => {
          receivedArgs = [repositoryId, githubIssueNumber]
          return Effect.succeed([actionableChild, blockedChild])
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementAllWithAutoMerge($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementAllWithAutoMerge(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id githubIssueNumber mergeMode state status statusLabel
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: 10,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        implementAllWithAutoMerge: [
          {
            id: actionableChild.id,
            githubIssueNumber: 43,
            mergeMode: "ALWAYS",
            state: "CREATE_WORKTREE",
            status: "RUNNING",
            statusLabel: "Running",
          },
          {
            id: blockedChild.id,
            githubIssueNumber: 44,
            mergeMode: "ALWAYS",
            state: "CREATE_WORKTREE",
            status: "WAITING_FOR_BLOCKERS",
            statusLabel: "Waiting for blockers",
          },
        ],
      },
    })
    expect(receivedArgs).toEqual([repository.id, 10])
  })

  test("maps Implement all with auto-merge domain failures", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementAllWithAutoMerge: () =>
          Effect.fail({
            _tag: "ImplementAllWithAutoMergeNotEligibleError",
            repositoryId: repository.id,
            githubIssueNumber: 10,
            reason: "Parent Issue #10 has no open Child Issues",
          } as never),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementAllWithAutoMerge($repositoryId: ID!, $githubIssueNumber: Int!) {
          implementAllWithAutoMerge(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: 10,
        },
      }),
    )

    const body = (await response.json()) as {
      errors: Array<{ message: string; extensions: { code: string } }>
    }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]?.extensions.code).toBe(
      "IMPLEMENT_ALL_WITH_AUTO_MERGE_NOT_ELIGIBLE",
    )
    expect(body.errors[0]?.message).toContain("no open Child Issues")
  })

  test("queues a blocked Issue Work Item", async () => {
    let receivedArgs: readonly [string, number] | undefined
    const held = {
      ...workItem,
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      waitingSince: null,
      stepRuns: [],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {
        queue: (repositoryId, githubIssueNumber) => {
          receivedArgs = [repositoryId, githubIssueNumber]
          return Effect.succeed(held)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $githubIssueNumber: Int!) {
          queue(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id state status statusLabel statusMessage canRetry isTerminal
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
        queue: {
          id: workItem.id,
          state: "CREATE_WORKTREE",
          status: "WAITING_FOR_BLOCKERS",
          statusLabel: "Waiting for blockers",
          statusMessage: "Queued — waiting for #17",
          canRetry: false,
          isTerminal: false,
        },
      },
    })
    expect(receivedArgs).toEqual([repository.id, issue.githubIssueNumber])
  })

  test("surfaces Queue errors for unblocked Issues and unfinished Work Items", async () => {
    const { IssueNotBlockedError, UnfinishedWorkItemExistsError } =
      await import("@ready-for-agent/work-item-lifecycle")

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        queue: () =>
          Effect.fail(
            new IssueNotBlockedError({
              repositoryId: repository.id,
              githubIssueNumber: issue.githubIssueNumber,
            }),
          ),
      },
    )
    const notBlocked = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $githubIssueNumber: Int!) {
          queue(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )
    expect(await notBlocked.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          extensions: expect.objectContaining({
            code: "ISSUE_NOT_BLOCKED",
          }),
        }),
      ],
    })

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        queue: () =>
          Effect.fail(
            new UnfinishedWorkItemExistsError({
              repositoryId: repository.id,
              githubIssueNumber: issue.githubIssueNumber,
              workItemId: workItem.id,
            }),
          ),
      },
    )
    const unfinished = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $githubIssueNumber: Int!) {
          queue(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          githubIssueNumber: issue.githubIssueNumber,
        },
      }),
    )
    expect(await unfinished.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          extensions: expect.objectContaining({
            code: "UNFINISHED_WORK_ITEM_EXISTS",
            workItemId: workItem.id,
          }),
        }),
      ],
    })
  })

  test("projects Waiting for blockers status and blocker copy", async () => {
    const held = {
      ...workItem,
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      waitingSince: null,
      stepRuns: [],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([issue]),
      },
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([held]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            status statusLabel statusMessage canRetry isTerminal paused
            lifecycleLabels { phase label status }
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
            status: "WAITING_FOR_BLOCKERS",
            statusLabel: "Waiting for blockers",
            statusMessage: "Queued — waiting for #17",
            canRetry: false,
            isTerminal: false,
            paused: false,
            lifecycleLabels: [],
          },
        ],
      },
    })
  })

  test("prefers terminal state over a stale waitingForBlockers flag", async () => {
    const abandonedHeld = {
      ...workItem,
      state: "abandoned",
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      waitingSince: null,
      failureMessage: null,
      stepRuns: [],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([abandonedHeld]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $githubIssueNumber: Int!) {
          workItems(repositoryId: $repositoryId, githubIssueNumber: $githubIssueNumber) {
            state status statusLabel statusMessage isTerminal
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
            state: "ABANDONED",
            status: "ABANDONED",
            statusLabel: "Abandoned",
            statusMessage: null,
            isTerminal: true,
          },
        ],
      },
    })
  })

  test("retries a failed Work Item", async () => {
    let receivedWorkItemId: string | undefined
    await runtime.dispose()
    runtime = makeRuntime(
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
        findSecret: () => Effect.die("must not inspect the vault on accept"),
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
    expect(enqueued).toEqual({
      queue: "issue-refresh",
      payload: {
        _tag: "refresh-repository",
        repositoryId: repository.id,
      },
      retryLimit: 1,
    })
  })

  test("accepts a Refresh Job with ambient GitHub authentication", async () => {
    const jobId = makeJobId()
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        enabled: false,
        findSecret: () => Effect.die("must not inspect the vault"),
      },
      {
        enqueue: () => {
          enqueued = true
          return Effect.succeed(jobId)
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

    expect(await response.json()).toEqual({
      data: {
        refreshRepository: {
          id: jobId,
          repositoryId: repository.id,
        },
      },
    })
    expect(enqueued).toBe(true)
  })

  test("bounds repositoryCredentials wait when Keymaxxer never resolves", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        findSecrets: () => Effect.never,
      },
    )

    const started = Date.now()
    const response = await createGraphqlApi(runtime, {
      keymaxxerMetadataTimeout: Duration.millis(50),
    }).fetch(
      graphqlRequest({
        query: `query {
          repositoryCredentials {
            repositoryId
            configured
          }
        }`,
      }),
    )
    const elapsedMs = Date.now() - started

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: expect.stringMatching(
            /Keymaxxer did not respond in time|vault unlock|secret-use approval/i,
          ),
          extensions: { code: "KEYMAXXER_ERROR" },
        }),
      ],
    })
    expect(elapsedMs).toBeLessThan(2_000)
  })

  test("rejects refresh for an unknown repository without enqueueing", async () => {
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
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
  })

  test("accepts a Refresh Job without inspecting Keymaxxer credentials", async () => {
    const jobId = makeJobId()
    let enqueued = false
    let vaultInspected = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {
        findSecret: () =>
          Effect.sync(() => {
            vaultInspected = true
            return null
          }),
        findSecrets: () =>
          Effect.sync(() => {
            vaultInspected = true
            return []
          }),
      },
      {
        enqueue: () => {
          enqueued = true
          return Effect.succeed(jobId)
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
      data: {
        refreshRepository: {
          id: jobId,
          repositoryId: repository.id,
        },
      },
    })
    expect(enqueued).toBe(true)
    expect(vaultInspected).toBe(false)
  })

  test("reports enqueue failure without accepting a Refresh Job", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {
        enqueue: () =>
          Effect.fail(
            new EnqueueError({
              queue: "issue-refresh",
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
      new Request("http://127.0.0.1:6056/graphql", {
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
      new Request("http://127.0.0.1:6056/graphql", {
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

  test("streams aggregate Work Item invalidations with Repository IDs", async () => {
    const otherRepositoryId = "repo-01J11111111111111111111111"
    await runtime.dispose()
    runtime = makeRuntime({
      workItemChanges: Stream.make(repository.id, otherRepositoryId),
    })

    const response = await createGraphqlApi(runtime).fetch(
      new Request("http://127.0.0.1:6056/graphql", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "subscription { repositoryWorkItemsChanged }",
        }),
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(
      `"data":{"repositoryWorkItemsChanged":"${repository.id}"}`,
    )
    expect(body).toContain(
      `"data":{"repositoryWorkItemsChanged":"${otherRepositoryId}"}`,
    )
  })

  test("accepts same-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest("http://127.0.0.1:6056"),
    )

    expect(response.status).toBe(200)
  })

  test("rejects cross-origin browser requests", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      addRepositoryRequest("https://malicious.example"),
    )

    expect(response.status).toBe(403)
  })

  test("committedPullRequestsCount aggregates via lifecycle with ISO bounds", async () => {
    const calls: Array<{ fromMs: number; toMs: number }> = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        countCommittedPullRequests: (fromMs, toMs) => {
          calls.push({ fromMs, toMs })
          return Effect.succeed(3)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Count($from: String!, $to: String!) {
          committedPullRequestsCount(from: $from, to: $to)
        }`,
        variables: {
          from: "2026-07-18T00:00:00.000Z",
          to: "2026-07-19T00:00:00.000Z",
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { committedPullRequestsCount: 3 },
    })
    expect(calls).toEqual([
      {
        fromMs: Date.parse("2026-07-18T00:00:00.000Z"),
        toMs: Date.parse("2026-07-19T00:00:00.000Z"),
      },
    ])
  })

  test("committedPullRequestsCount rejects invalid ISO instants", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Count($from: String!, $to: String!) {
          committedPullRequestsCount(from: $from, to: $to)
        }`,
        variables: {
          from: "not-a-date",
          to: "2026-07-19T00:00:00.000Z",
        },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      errors?: ReadonlyArray<{ message: string }>
    }
    expect(body.errors?.[0]?.message).toContain("Invalid ISO instant for from")
  })

  test("session returns null for unknown Work Item", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.fail(new WorkItemNotFoundError({ workItemId: "wi-missing" })),
      },
      {
        getSessionTelemetry: () => Effect.die("telemetry must not run"),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) { id availability }
        }`,
        variables: { workItemId: "wi-missing" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { session: null },
    })
  })

  test("session returns AVAILABLE usage for Work Item Session", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            sessionId: "ses_owned",
          }),
      },
      {
        getSessionTelemetry: (input) =>
          Effect.succeed({
            id: input.sessionId ?? "",
            availability: "available",
            backend: { id: "opencode", label: "OpenCode" },
            model: {
              providerId: "openai",
              id: "gpt-5.5",
              thinkingLevel: "xhigh",
            },
            tokens: {
              input: 100,
              output: 20,
              reasoning: 5,
              cacheRead: 50,
              cacheWrite: 10,
            },
            cost: 1.25,
            createdAt: "2026-07-14T08:00:00.000Z",
            updatedAt: "2026-07-14T09:00:00.000Z",
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) {
            id
            availability
            backend { id label }
            model { providerId id thinkingLevel }
            tokens { input output reasoning cacheRead cacheWrite }
            cost
            createdAt
            updatedAt
          }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        session: {
          id: "ses_owned",
          availability: "AVAILABLE",
          backend: { id: "opencode", label: "OpenCode" },
          model: {
            providerId: "openai",
            id: "gpt-5.5",
            thinkingLevel: "xhigh",
          },
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cacheRead: 50,
            cacheWrite: 10,
          },
          cost: 1.25,
          createdAt: "2026-07-14T08:00:00.000Z",
          updatedAt: "2026-07-14T09:00:00.000Z",
        },
      },
    })
  })

  test("session returns MISSING with null metrics when Session row is gone", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            sessionId: "ses_missing",
          }),
      },
      {
        getSessionTelemetry: (input) =>
          Effect.succeed({
            id: input.sessionId ?? "",
            availability: "missing",
            backend: { id: "opencode", label: "OpenCode" },
            model: null,
            tokens: null,
            cost: null,
            createdAt: null,
            updatedAt: null,
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) {
            id
            availability
            backend { label }
            model { id }
            tokens { input }
            cost
            createdAt
            updatedAt
          }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        session: {
          id: "ses_missing",
          availability: "MISSING",
          backend: { label: "OpenCode" },
          model: null,
          tokens: null,
          cost: null,
          createdAt: null,
          updatedAt: null,
        },
      },
    })
  })

  test("session returns UNAVAILABLE with null metrics on lock/read failure", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            sessionId: "ses_locked",
          }),
      },
      {
        getSessionTelemetry: (input) =>
          Effect.succeed({
            id: input.sessionId ?? "",
            availability: "unavailable",
            backend: { id: "opencode", label: "OpenCode" },
            model: null,
            tokens: null,
            cost: null,
            createdAt: null,
            updatedAt: null,
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) {
            id
            availability
            backend { label }
            model { id }
            tokens { input }
            cost
          }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        session: {
          id: "ses_locked",
          availability: "UNAVAILABLE",
          backend: { label: "OpenCode" },
          model: null,
          tokens: null,
          cost: null,
        },
      },
    })
  })

  test("session returns UNSUPPORTED when backend has no telemetry capability", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            agentBackend: "opencode",
            sessionId: "ses_any",
          }),
      },
      {
        getSessionTelemetry: (input) =>
          Effect.succeed({
            id: input.sessionId ?? "",
            availability: "unsupported",
            backend: { id: "opencode", label: "OpenCode" },
            model: null,
            tokens: null,
            cost: null,
            createdAt: null,
            updatedAt: null,
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) {
            id
            availability
            backend { id label }
            model { id }
            cost
          }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        session: {
          id: "ses_any",
          availability: "UNSUPPORTED",
          backend: { id: "opencode", label: "OpenCode" },
          model: null,
          cost: null,
        },
      },
    })
  })
})
