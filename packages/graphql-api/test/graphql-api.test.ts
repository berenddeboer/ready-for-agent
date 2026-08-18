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
import {
  AgentBackendChangeBlockedError,
  DbService,
  type DbServiceShape,
} from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbService,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRepositoryUnavailableError,
  GitHubService,
  type GitHubServiceShape,
  GitHubThrottledError,
} from "@ready-for-agent/github-service"
import {
  GitLabProjectUnavailableError,
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { evaluateUnfinishedWorkItem } from "@ready-for-agent/lifecycle-model"
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
  ActiveStepRunExistsError,
  AutonomousRetryDeferredError,
  AutonomousRetryLimitReachedError,
  InvalidExecutionProfileError,
  IssueNotFoundError,
  RetryNotEligibleError,
  STEP_RUN_REASON,
  SessionIdAmbiguousError,
  SessionIdNotFoundError,
  UnfinishedWorkItemExistsError,
  WAITING_FOR_AGENT_TURN_MESSAGE,
  WorkItemLifecycle,
  type WorkItemLifecycleShape,
  WorkItemNotFoundError,
  type WorkItemRecord,
  makeWorkItemId,
} from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi } from "../src/index.js"
import { workItemCanRetry } from "../src/lib/work-item-projection.js"
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
  defaultThinkingLevel: "high",
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
  provider: AgentBackendRuntimeStatus["provider"] = null,
  warnings: AgentBackendRuntimeStatus["warnings"] = [],
): AgentBackendRuntimeStatus => ({
  backend: {
    id: backendId,
    label: backendId === "opencode" ? "OpenCode" : backendId,
  },
  kind: "ready",
  reason: null,
  models,
  provider,
  warnings,
})

const readyStatus = (
  models: AgentBackendStatus["models"] = defaultModels,
): AgentBackendStatus => toAgentBackendStatus(readyRuntimeStatus(models))

const issue = {
  id: "issue-test",
  repositoryId: repository.id,
  issueNumber: 42,
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
      issueNumber: 17,
      issueUrl: "https://github.com/acme/widgets/issues/17",
    },
  ],
}

const workItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: repository.id,
  issueNumber: issue.issueNumber,
  issueTitle: issue.title,
  agentBackend: "opencode",
  state: "create_worktree",
  stateReadyAt: new Date("2026-07-14T08:00:00.000Z"),
  paused: false,
  waitingSince: null,
  waitingForBlockers: false,
  mergeMode: "ordinary",
  autoMergeOverride: null,
  holdsWorkerSlot: true,
  pauseBeforeStep: null,
  worktreePath: null,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: null,
  pullRequestNumber: null,
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
  closeOpenPullRequestsAndDeleteBranch: () => Effect.void,
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
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
  observeAutomatedReviewEvidence: () =>
    Effect.succeed({
      _tag: "ambiguous" as const,
      reason: "Automated review evidence observation is not configured",
    }),
  getPullRequestLifecycleStatus: () => Effect.succeed({ _tag: "open" }),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  rerunWorkflowRun: () => Effect.void,
  uploadUserAttachment: () =>
    Effect.succeed(
      "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
    ),
  ensureIssueCompletedWithSummary: () => Effect.void,
  listReadyIssues: () => Effect.succeed([]),
}

const defaultGitlab: GitLabServiceShape = {
  verifyProject: (repository) => Effect.succeed(repository),
  getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
  listReadyIssues: () => Effect.succeed([]),
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
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
  markPullRequestReadyForReview: () => Effect.void,
  getPullRequestLifecycleStatus: () =>
    Effect.succeed({ _tag: "open" as const }),
  mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
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
  gitlabOverrides: Partial<GitLabServiceShape> = {},
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
    implementWith: unused,
    implementLocally: unused,
    implementAllWithAutoMerge: unused,
    queue: unused,
    recoverOrphanedStepRuns: Effect.succeed(0),
    interruptRunningStepRunsFromPriorWorker: Effect.succeed(0),
    runStep: unused,
    wakePostponedStep: unused,
    retry: unused,
    pause: unused,
    interrupt: unused,
    start: unused,
    abandon: unused,
    reset: unused,
    getWorkItem: unused,
    listWorkItemsForIssue: unused,
    listWorkItemsForRepository: unused,
    listCompletedWorkItems: unused,
    ownsSessionId: () => Effect.succeed(false),
    findWorkItemBySessionId: unused,
    countCommittedPullRequests: unused,
    continueAfterHumanPrOutcome: unused,
    stopForCompetingIssueClosingPullRequests: () => Effect.succeed(0),
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
        provider: null,
        warnings: [],
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
    getAgentTurnTail: () =>
      Effect.succeed({
        availability: "unsupported" as const,
        backend: { id: "opencode", label: "OpenCode" },
        items: [],
        jumpHint: false,
      }),
    ...activeBackendOverrides,
  }
  const localGit = Layer.succeed(LocalGit, {
    inspect: (path) =>
      Effect.succeed({
        forge: repository.forge,
        forgeHost: repository.forgeHost,
        projectPath: repository.projectPath,
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
      Layer.succeed(GitLabService, {
        ...defaultGitlab,
        ...gitlabOverrides,
      }),
      localGit,
      directoryPicker,
    ),
  )
}

const graphqlRequest = (body: unknown, origin?: string, signal?: AbortSignal) =>
  new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
    }
    await Bun.sleep(5)
  }
}

const addRepositoryRequest = (origin?: string) =>
  graphqlRequest(
    {
      query: `mutation AddRepository($input: AddRepositoryInput!) {
        addRepository(input: $input) { id forge forgeHost projectPath }
      }`,
      variables: {
        input: {
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
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

  test("reports the injected product version on Query.version", async () => {
    const response = await createGraphqlApi(runtime, {
      version: "0.18.0",
    }).fetch(
      graphqlRequest({
        query: "{ version }",
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { version: "0.18.0" },
    })
  })

  test("defaults Query.version to the placeholder product version", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: "{ version }",
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { version: "0.0.0" },
    })
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
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
        },
      },
    })
  })

  test("verifies a GitLab project before adding the repository", async () => {
    const actions: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {
        addRepository: (input) => {
          actions.push(`add:${input.forgeHost}/${input.projectPath}`)
          return Effect.succeed({ ...repository, ...input })
        },
      },
      {},
      {},
      {},
      {},
      {},
      {},
      {
        verifyProject: (identity) =>
          Effect.sync(() => {
            actions.push(`verify:${identity.forgeHost}/${identity.projectPath}`)
            return identity
          }),
        hasCredentials: () => Effect.succeed(false),
        hasAmbientCredentials: () => Effect.succeed(false),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation AddRepository($input: AddRepositoryInput!) {
          addRepository(input: $input) { id }
        }`,
        variables: {
          input: {
            forge: "gitlab",
            forgeHost: "gitlab.com",
            projectPath: "acme/widgets",
            localPath: "/tmp/acme-widgets",
            isBare: false,
          },
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addRepository: {
          id: repository.id,
        },
      },
    })
    expect(actions).toEqual([
      "verify:gitlab.com/acme/widgets",
      "add:gitlab.com/acme/widgets",
    ])
  })

  test("persists the canonical GitLab API host when verify resolves a different host", async () => {
    let addedInput: {
      forge: "github" | "gitlab"
      forgeHost: string
      projectPath: string
      localPath: string
      isBare: boolean
    } | null = null
    await runtime.dispose()
    runtime = makeRuntime(
      {
        addRepository: (input) => {
          addedInput = input
          return Effect.succeed({
            ...repository,
            forge: input.forge,
            forgeHost: input.forgeHost,
            projectPath: input.projectPath,
            localPath: input.localPath,
            isBare: input.isBare,
          })
        },
      },
      {},
      {},
      {},
      {},
      {
        inspect: (path) =>
          Effect.succeed({
            forge: "gitlab" as const,
            forgeHost: "git.drupal.org",
            projectPath: "project/oauth_client",
            localPath: path,
            isBare: false,
            paused: true as const,
          }),
      },
      {},
      {
        verifyProject: (identity) =>
          Effect.succeed({
            forge: identity.forge,
            forgeHost: "git.drupalcode.org",
            projectPath: identity.projectPath,
          }),
        hasCredentials: () => Effect.succeed(false),
        hasAmbientCredentials: () => Effect.succeed(false),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation AddLocal($path: String!) {
          addLocalRepository(path: $path) {
            forge
            forgeHost
            projectPath
          }
        }`,
        variables: { path: "/tmp/oauth_client" },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addLocalRepository: {
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
        },
      },
    })
    expect(addedInput).toEqual({
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
      localPath: "/tmp/oauth_client",
      isBare: false,
    })
  })

  test("rejects an unknown GitLab project before saving", async () => {
    let addRepositoryCalled = false
    await runtime.dispose()
    runtime = makeRuntime(
      {
        addRepository: () => {
          addRepositoryCalled = true
          return Effect.succeed(repository)
        },
      },
      {},
      {},
      {},
      {},
      {},
      {},
      {
        verifyProject: (identity) =>
          Effect.fail(new GitLabProjectUnavailableError(identity)),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation AddRepository($input: AddRepositoryInput!) {
          addRepository(input: $input) { id }
        }`,
        variables: {
          input: {
            forge: "gitlab",
            forgeHost: "gitlab.example",
            projectPath: "missing/project",
            localPath: "/tmp/missing-project",
            isBare: false,
          },
        },
      }),
    )

    expect(await response.json()).toMatchObject({
      errors: [
        {
          extensions: { code: "GITLAB_PROJECT_UNAVAILABLE" },
        },
      ],
    })
    expect(addRepositoryCalled).toBe(false)
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
      forge: "github" | "gitlab"
      forgeHost: string
      projectPath: string
      localPath: string
      isBare: boolean
    } | null = null
    const addRuntime = makeRuntime({
      addRepository: (input) => {
        addedInput = input
        return Effect.succeed({
          ...repository,
          forge: input.forge,
          forgeHost: input.forgeHost,
          projectPath: input.projectPath,
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
              forge
              forgeHost
              projectPath
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
            forge: repository.forge,
            forgeHost: repository.forgeHost,
            projectPath: repository.projectPath,
            localPath: "/tmp/fixture-repo",
            isBare: repository.isBare,
          },
        },
      })
      expect(addedInput).toEqual({
        forge: repository.forge,
        forgeHost: repository.forgeHost,
        projectPath: repository.projectPath,
        localPath: "/tmp/fixture-repo",
        isBare: repository.isBare,
      })
    } finally {
      await addRuntime.dispose()
    }
  })

  test("inspectLocalRepository returns the guessed identity without saving", async () => {
    let addRepositoryCalled = false
    const inspectRuntime = makeRuntime({
      addRepository: () => {
        addRepositoryCalled = true
        return Effect.succeed(repository)
      },
    })

    try {
      const response = await createGraphqlApi(inspectRuntime).fetch(
        graphqlRequest({
          query: `mutation {
            inspectLocalRepository(path: "/tmp/fixture-repo") {
              forge
              forgeHost
              projectPath
              localPath
              isBare
            }
          }`,
        }),
      )

      expect(await response.json()).toEqual({
        data: {
          inspectLocalRepository: {
            forge: repository.forge,
            forgeHost: repository.forgeHost,
            projectPath: repository.projectPath,
            localPath: "/tmp/fixture-repo",
            isBare: repository.isBare,
          },
        },
      })
      expect(addRepositoryCalled).toBe(false)
    } finally {
      await inspectRuntime.dispose()
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
            provider === "github" && account === `${repository.projectPath}`
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
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
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
    expect(ensured[0]?.delayMs).toBeGreaterThanOrEqual(60_000)
    expect(ensured[0]?.delayMs).toBeLessThanOrEqual(90_000)
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

  test("activates Issue Polling when ambient GitLab authentication resolves", async () => {
    let ensured = false
    let enqueued = false
    await runtime.dispose()
    runtime = makeRuntime(
      {
        addRepository: (input) =>
          Effect.succeed({ ...repository, ...input, paused: true }),
      },
      {
        // Vault-first: look up the GitLab secret (miss), then fall back to ambient.
        findSecret: ({ provider }) =>
          provider === "github"
            ? Effect.die("must not inspect GitHub credentials")
            : Effect.succeed(null),
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
      {},
      {},
      {},
      {},
      {
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation AddRepository($input: AddRepositoryInput!) {
          addRepository(input: $input) { id paused }
        }`,
        variables: {
          input: {
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/oauth_client",
            localPath: "/tmp/oauth_client",
            isBare: false,
          },
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addRepository: {
          id: repository.id,
          paused: true,
        },
      },
    })
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
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
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
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
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
            forge
            forgeHost
            projectPath
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
            forge: repository.forge,
            forgeHost: repository.forgeHost,
            projectPath: repository.projectPath,
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
      `${repository.projectPath.split("/").at(-1)} - ready-for-agent`,
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
            reviewModel: "opencode/deepseek-v4-flash-free",
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
          reviewModel: "opencode/deepseek-v4-flash-free",
          reviewThinkingLevel: "max",
          maxConcurrentAgentTurns: 3,
          maxConcurrentWorkItems: 7,
        },
      },
    })
  })

  test("updateConfig rejects an Agent Model outside the current catalog", async () => {
    // Issue #838: Settings is catalog-only, and a direct GraphQL request must
    // not be able to store a model the Agent Backend does not offer.
    const updateCalls: string[] = []
    const strictRuntime = makeRuntime({
      updateConfig: (input) => {
        updateCalls.push(input.selectedAgentBackend)
        return Effect.succeed({
          selectedAgentBackend: input.selectedAgentBackend,
          defaultModel: input.defaultModel,
          defaultThinkingLevel: input.defaultThinkingLevel,
          reviewModel: input.reviewModel,
          reviewThinkingLevel: input.reviewThinkingLevel,
          maxConcurrentAgentTurns: input.maxConcurrentAgentTurns,
          maxConcurrentWorkItems: input.maxConcurrentWorkItems,
        })
      },
    })

    const response = await createGraphqlApi(strictRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            // Legacy Bedrock profile left over under another provider mode.
            defaultModel: "us.anthropic.claude-sonnet-4-6",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      data?: { updateConfig: unknown } | null
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultModel",
    })
    expect(payload.errors?.[0]?.message).toContain(
      "us.anthropic.claude-sonnet-4-6",
    )
    // Nothing was persisted.
    expect(updateCalls).toEqual([])
    await strictRuntime.dispose()
  })

  test("updateConfig identifies the review model field when only it is invalid", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: null,
            reviewModel: "sonnet",
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "reviewModel",
    })
  })

  test("updateConfig validates against the next backend, not the current one", async () => {
    // Switching backends must be judged by what the *next* backend offers.
    // grok is not Active here, so validation goes through the Preview path.
    const previewCalls: string[] = []
    const switchRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: (backendId) =>
          Effect.succeed(
            backendId === "opencode" ? readyRuntimeStatus() : null,
          ),
        preview: (backendId) => {
          previewCalls.push(backendId)
          return Effect.succeed({
            backend: { id: backendId, label: backendId },
            kind: "ready" as const,
            reason: null,
            models: [{ id: "grok-code-fast-1", thinkingLevels: [] }],
            provider: null,
            warnings: [],
          })
        },
      },
    )

    const rejected = await createGraphqlApi(switchRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "grok",
            // In the *current* backend's catalog, absent from grok's.
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
    const rejectedPayload = (await rejected.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(rejectedPayload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultModel",
    })
    expect(previewCalls).toEqual(["grok"])

    const accepted = await createGraphqlApi(switchRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "grok",
            defaultModel: "grok-code-fast-1",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await accepted.json()).toEqual({
      data: { updateConfig: { defaultModel: "grok-code-fast-1" } },
    })
    await switchRuntime.dispose()
  })

  test("updateConfig cannot validate an explicit model without a catalog", async () => {
    const unavailableRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () =>
          Effect.succeed({
            ...readyRuntimeStatus(),
            kind: "unavailable" as const,
            reason: "opencode CLI is not installed",
            models: [],
          }),
      },
    )

    const response = await createGraphqlApi(unavailableRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultModel",
    })
    expect(payload.errors?.[0]?.message).toContain("catalog is unavailable")
    expect(payload.errors?.[0]?.message).toContain(
      "opencode CLI is not installed",
    )
    await unavailableRuntime.dispose()
  })

  test("updateConfig clears models without consulting a catalog", async () => {
    // Clearing on a backend change must keep working even when no catalog can
    // be produced — an empty model asserts nothing about membership.
    const previewCalls: string[] = []
    const clearingRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () => Effect.succeed(null),
        preview: (backendId) => {
          previewCalls.push(backendId)
          return Effect.die("preview must not run for empty models")
        },
      },
    )

    const response = await createGraphqlApi(clearingRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultModel }
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
    expect(await response.json()).toEqual({
      data: { updateConfig: { defaultModel: null } },
    })
    expect(previewCalls).toEqual([])
    await clearingRuntime.dispose()
  })

  test("updateConfig rejects a Thinking Level the build model does not advertise", async () => {
    const updateCalls: unknown[] = []
    const syncCalls: string[][] = []
    const strictRuntime = makeRuntime(
      {
        updateConfig: (input) => {
          updateCalls.push(input)
          return Effect.succeed({
            selectedAgentBackend: input.selectedAgentBackend,
            defaultModel: input.defaultModel,
            defaultThinkingLevel: input.defaultThinkingLevel,
            reviewModel: input.reviewModel,
            reviewThinkingLevel: input.reviewThinkingLevel,
            maxConcurrentAgentTurns: input.maxConcurrentAgentTurns,
            maxConcurrentWorkItems: input.maxConcurrentWorkItems,
          })
        },
      },
      {},
      {},
      {},
      {
        setSelectedOrInUse: (backendIds) => {
          syncCalls.push([...backendIds])
          return Effect.succeed(
            backendIds.map((id) => readyRuntimeStatus(defaultModels, id)),
          )
        },
      },
    )

    const response = await createGraphqlApi(strictRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: "medium",
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultThinkingLevel",
    })
    expect(payload.errors?.[0]?.message).toContain("medium")
    expect(payload.errors?.[0]?.message).toContain(
      "opencode/deepseek-v4-flash-free",
    )
    expect(payload.errors?.[0]?.message).toContain("OpenCode")
    expect(payload.errors?.[0]?.message).toContain("high, max")
    expect(payload.errors?.[0]?.message).toContain("clear the field")
    expect(updateCalls).toEqual([])
    expect(syncCalls).toEqual([])
    await strictRuntime.dispose()
  })

  test("updateConfig rejects a review Thinking Level for an explicit review model", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: "opencode/deepseek-v4-flash-free",
            reviewThinkingLevel: "low",
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "reviewThinkingLevel",
    })
  })

  test("updateConfig validates review Thinking Level against the build model when review has no distinct model", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: "medium",
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "reviewThinkingLevel",
    })
    expect(payload.errors?.[0]?.message).toContain(
      "opencode/deepseek-v4-flash-free",
    )
  })

  test("updateConfig accepts an advertised Thinking Level, null, and whitespace", async () => {
    const accepted = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultThinkingLevel reviewThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: "   ",
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await accepted.json()).toEqual({
      data: {
        updateConfig: {
          defaultThinkingLevel: "high",
          reviewThinkingLevel: "   ",
        },
      },
    })
  })

  test("updateConfig rejects every non-null Thinking Level when the model offers none", async () => {
    const emptyLevelsRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () =>
          Effect.succeed(
            readyRuntimeStatus([
              { id: "opencode/gpt-5", thinkingLevels: [] },
              {
                id: "opencode/deepseek-v4-flash-free",
                thinkingLevels: ["high", "max"],
              },
            ]),
          ),
      },
    )
    const rejected = await createGraphqlApi(emptyLevelsRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/gpt-5",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const rejectedPayload = (await rejected.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(rejectedPayload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultThinkingLevel",
    })
    expect(rejectedPayload.errors?.[0]?.message).toContain(
      "offers no Thinking Levels",
    )

    const accepted = await createGraphqlApi(emptyLevelsRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/gpt-5",
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    expect(await accepted.json()).toEqual({
      data: { updateConfig: { defaultThinkingLevel: null } },
    })
    await emptyLevelsRuntime.dispose()
  })

  test("updateConfig validates Thinking Levels through Agent Backend Preview", async () => {
    const previewCalls: string[] = []
    const previewRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () => Effect.succeed(null),
        preview: (backendId) => {
          previewCalls.push(backendId)
          return Effect.succeed({
            backend: { id: backendId, label: "Grok" },
            kind: "ready" as const,
            reason: null,
            models: [
              { id: "grok-code-fast-1", thinkingLevels: ["low", "high"] },
            ],
            provider: null,
            warnings: [],
          })
        },
      },
    )
    const rejected = await createGraphqlApi(previewRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) { defaultThinkingLevel }
        }`,
        variables: {
          input: {
            selectedAgentBackend: "grok",
            defaultModel: "grok-code-fast-1",
            defaultThinkingLevel: "max",
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          },
        },
      }),
    )
    const payload = (await rejected.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_CONFIG_INPUT",
      field: "defaultThinkingLevel",
    })
    expect(previewCalls).toEqual(["grok"])
    await previewRuntime.dispose()
  })

  test("updateRepositorySettings rejects an applicable Thinking Level and preserves a dormant one", async () => {
    const settingsCalls: unknown[] = []
    const repoRuntime = makeRuntime({
      getBackendModelPrefs: () =>
        Effect.succeed({
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "high",
          reviewModel: "anthropic/claude-sonnet-4-5",
          reviewThinkingLevel: "high",
        }),
      updateRepositorySettings: (input) => {
        settingsCalls.push(input)
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
    })
    const save = (input: {
      defaultModel: string | null
      defaultThinkingLevel: string | null
      reviewModel: string | null
      reviewThinkingLevel: string | null
    }) =>
      createGraphqlApi(repoRuntime).fetch(
        graphqlRequest({
          query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
            updateRepositorySettings(input: $input) {
              defaultThinkingLevel
              reviewThinkingLevel
            }
          }`,
          variables: {
            input: {
              repositoryId: repository.id,
              paused: false,
              selectedAgentBackend: null,
              autoMerge: true,
              includeAllIssueAuthors: false,
              waitForReadyForReviewChecks: false,
              ...input,
            },
          },
        }),
      )

    const rejected = (await (
      await save({
        defaultModel: "opencode/deepseek-v4-flash-free",
        defaultThinkingLevel: "medium",
        reviewModel: null,
        reviewThinkingLevel: "medium",
      })
    ).json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(rejected.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "defaultThinkingLevel",
    })
    expect(settingsCalls).toEqual([])

    const dormant = await save({
      defaultModel: null,
      defaultThinkingLevel: "medium",
      reviewModel: null,
      reviewThinkingLevel: "medium",
    })
    expect(await dormant.json()).toEqual({
      data: {
        updateRepositorySettings: {
          defaultThinkingLevel: "medium",
          reviewThinkingLevel: "medium",
        },
      },
    })
    expect(settingsCalls).toHaveLength(1)
    await repoRuntime.dispose()
  })

  test("updateRepositorySettings validates review Thinking Level against harness review then resolved build", async () => {
    const harnessReviewRuntime = makeRuntime({
      getBackendModelPrefs: () =>
        Effect.succeed({
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "high",
          reviewModel: "opencode/deepseek-v4-flash-free",
          reviewThinkingLevel: "high",
        }),
    })
    const inheritedReviewRejected = await createGraphqlApi(
      harnessReviewRuntime,
    ).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: "medium",
            autoMerge: true,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    expect(await inheritedReviewRejected.json()).toEqual({
      data: { updateRepositorySettings: { reviewThinkingLevel: "medium" } },
    })
    await harnessReviewRuntime.dispose()

    const buildFallbackRuntime = makeRuntime({
      getBackendModelPrefs: () =>
        Effect.succeed({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
        }),
    })
    const buildFallback = await createGraphqlApi(buildFallbackRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: "medium",
            autoMerge: true,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    const buildFallbackPayload = (await buildFallback.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(buildFallbackPayload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "reviewThinkingLevel",
    })
    expect(buildFallbackPayload.errors?.[0]?.message).toContain(
      "opencode/deepseek-v4-flash-free",
    )
    await buildFallbackRuntime.dispose()
  })

  test("updateRepositorySettings rejects applicable review Thinking Level when the inherited build model is absent from the catalog", async () => {
    const settingsCalls: unknown[] = []
    const missingGovernorRuntime = makeRuntime({
      getBackendModelPrefs: () =>
        Effect.succeed({
          defaultModel: "us.anthropic.claude-sonnet-4-6",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
        }),
      updateRepositorySettings: (input) => {
        settingsCalls.push(input)
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
    })
    const response = await createGraphqlApi(missingGovernorRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: "medium",
            autoMerge: true,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "reviewThinkingLevel",
    })
    expect(payload.errors?.[0]?.message).toContain(
      "us.anthropic.claude-sonnet-4-6",
    )
    expect(settingsCalls).toEqual([])
    await missingGovernorRuntime.dispose()
  })

  test("updateRepositorySettings rejects applicable review Thinking Level when the Ready catalog is empty", async () => {
    const settingsCalls: unknown[] = []
    const emptyCatalogRuntime = makeRuntime(
      {
        getBackendModelPrefs: () =>
          Effect.succeed({
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: null,
          }),
        updateRepositorySettings: (input) => {
          settingsCalls.push(input)
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
      },
      {},
      {},
      {},
      {
        getBackendStatus: () => Effect.succeed(readyRuntimeStatus([])),
      },
    )
    const response = await createGraphqlApi(emptyCatalogRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { reviewThinkingLevel }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: "medium",
            autoMerge: true,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "reviewThinkingLevel",
    })
    expect(settingsCalls).toEqual([])
    await emptyCatalogRuntime.dispose()
  })

  test("updateRepositorySettings cannot persist an applicable Thinking Level when the catalog is unavailable", async () => {
    const unavailableRuntime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        getBackendStatus: () =>
          Effect.succeed({
            ...readyRuntimeStatus(),
            kind: "unavailable" as const,
            reason: "opencode CLI is not installed",
            models: [],
          }),
      },
    )
    const response = await createGraphqlApi(unavailableRuntime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { defaultThinkingLevel }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: false,
            selectedAgentBackend: null,
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: true,
            includeAllIssueAuthors: false,
            waitForReadyForReviewChecks: false,
          },
        },
      }),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{
        message: string
        extensions?: { code?: string; field?: string }
      }>
    }
    expect(payload.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "defaultModel",
    })
    expect(payload.errors?.[0]?.message).toContain("catalog is unavailable")
    await unavailableRuntime.dispose()
  })

  test("updateRepositorySettings enforces the next Effective backend catalog", async () => {
    const settingsCalls: unknown[] = []
    const repoRuntime = makeRuntime({
      updateRepositorySettings: (input) => {
        settingsCalls.push(input)
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
    })
    const overrideInput = (defaultModel: string | null) => ({
      repositoryId: repository.id,
      paused: false,
      selectedAgentBackend: null,
      defaultModel,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      autoMerge: true,
      includeAllIssueAuthors: false,
      waitForReadyForReviewChecks: false,
    })
    const save = (defaultModel: string | null) =>
      createGraphqlApi(repoRuntime).fetch(
        graphqlRequest({
          query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
            updateRepositorySettings(input: $input) { defaultModel }
          }`,
          variables: { input: overrideInput(defaultModel) },
        }),
      )

    const rejected = (await (
      await save("us.anthropic.claude-sonnet-4-6")
    ).json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string; field?: string } }>
    }
    expect(rejected.errors?.[0]?.extensions).toEqual({
      code: "INVALID_REPOSITORY_SETTINGS",
      field: "defaultModel",
    })
    expect(settingsCalls).toEqual([])

    // Clearing the override back to inheritance is always allowed.
    expect(await (await save(null)).json()).toEqual({
      data: { updateRepositorySettings: { defaultModel: null } },
    })
    expect(settingsCalls).toHaveLength(1)
    await repoRuntime.dispose()
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
            reviewModel: "opencode/deepseek-v4-flash-free",
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
          reviewModel: "opencode/deepseek-v4-flash-free",
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

  test("updates Project Path display casing without re-verifying Forge identity", async () => {
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "Group/Widgets",
    })
    let verifications = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
        updateRepositorySettings: (input) =>
          Effect.succeed({
            ...gitlabRepository,
            projectPath: input.projectPath ?? gitlabRepository.projectPath,
          }),
      },
      {},
      {},
      {},
      {},
      {},
      {},
      {
        verifyProject: (identity) => {
          verifications += 1
          return Effect.succeed(identity)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { projectPath }
        }`,
        variables: {
          input: {
            repositoryId: gitlabRepository.id,
            forge: "gitlab",
            forgeHost: "gitlab.example",
            projectPath: "group/widgets",
            paused: true,
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

    expect(await response.json()).toEqual({
      data: {
        updateRepositorySettings: {
          projectPath: "group/widgets",
        },
      },
    })
    expect(verifications).toBe(0)
  })

  test("persists canonical Forge Host when updateRepositorySettings re-verifies identity", async () => {
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "git.drupal.org",
      projectPath: "project/oauth_client",
    })
    let settingsInput: {
      forgeHost?: string
      projectPath?: string
    } | null = null
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
        updateRepositorySettings: (input) => {
          settingsInput = {
            forgeHost: input.forgeHost,
            projectPath: input.projectPath,
          }
          return Effect.succeed({
            ...gitlabRepository,
            forge: input.forge ?? gitlabRepository.forge,
            forgeHost: input.forgeHost ?? gitlabRepository.forgeHost,
            projectPath: input.projectPath ?? gitlabRepository.projectPath,
          })
        },
      },
      {},
      {
        // Identity correction suspends then re-activates Issue Polling.
        removeKeyed: () => Effect.succeed(0),
        ensureKeyed: () => Effect.succeed(makeJobId()),
      },
      {},
      {},
      {},
      {},
      {
        verifyProject: (identity) =>
          Effect.succeed({
            forge: identity.forge,
            forgeHost: "git.drupalcode.org",
            projectPath: identity.projectPath,
          }),
        hasCredentials: () => Effect.succeed(false),
        hasAmbientCredentials: () => Effect.succeed(false),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            forgeHost
            projectPath
          }
        }`,
        variables: {
          input: {
            repositoryId: gitlabRepository.id,
            forge: "gitlab",
            forgeHost: "git.drupal.org",
            projectPath: "project/other_client",
            paused: true,
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

    expect(await response.json()).toEqual({
      data: {
        updateRepositorySettings: {
          forgeHost: "git.drupalcode.org",
          projectPath: "project/other_client",
        },
      },
    })
    expect(settingsInput).toEqual({
      forgeHost: "git.drupalcode.org",
      projectPath: "project/other_client",
    })
  })

  test("exposes scoped gate counts on Config and Repository", async () => {
    await runtime.dispose()
    const counted: Array<{
      forge: "github" | "gitlab"
      forgeHost: string
      projectPath: string
    }> = []
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
      {
        forge: repository.forge,
        forgeHost: repository.forgeHost,
        projectPath: repository.projectPath,
      },
    ])
  })

  test("updateConfig returns a zero blocking count while unfinished Work Items remain", async () => {
    await runtime.dispose()
    runtime = makeRuntime({
      countUnfinishedWorkItems: Effect.succeed(2),
      countBlockingUnfinishedForGlobalDefault: Effect.succeed(0),
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateConfig($input: UpdateConfigInput!) {
          updateConfig(input: $input) {
            selectedAgentBackend
            unfinishedWorkItemCount
            blockingUnfinishedWorkItemCount
          }
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
    expect(await response.json()).toEqual({
      data: {
        updateConfig: {
          selectedAgentBackend: "grok",
          unfinishedWorkItemCount: 2,
          blockingUnfinishedWorkItemCount: 0,
        },
      },
    })
  })

  test("updateConfig maps AgentBackendChangeBlockedError for a global ordinary gate", async () => {
    await runtime.dispose()
    runtime = makeRuntime({
      updateConfig: () =>
        Effect.fail(
          new AgentBackendChangeBlockedError({
            message:
              "Cannot change default Agent Backend while 1 Work Item(s) are unfinished on Repositories that inherit the default",
            unfinishedWorkItemCount: 1,
            scope: "global",
          }),
        ),
    })

    const response = await createGraphqlApi(runtime).fetch(
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
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message:
            "Cannot change default Agent Backend while 1 Work Item(s) are unfinished on Repositories that inherit the default",
          extensions: {
            code: "AGENT_BACKEND_CHANGE_BLOCKED",
            unfinishedWorkItemCount: 1,
            scope: "global",
          },
        }),
      ],
    })
  })

  test("updateRepositorySettings persists an override when the repository blocking count is zero", async () => {
    await runtime.dispose()
    let savedBackend: string | null | undefined
    runtime = makeRuntime({
      countBlockingUnfinishedForRepository: () => Effect.succeed(0),
      updateRepositorySettings: (input) => {
        savedBackend = input.selectedAgentBackend
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
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            selectedAgentBackend
            blockingUnfinishedWorkItemCount
          }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: true,
            selectedAgentBackend: "grok",
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
    expect(await response.json()).toEqual({
      data: {
        updateRepositorySettings: {
          selectedAgentBackend: "grok",
          blockingUnfinishedWorkItemCount: 0,
        },
      },
    })
    expect(savedBackend).toBe("grok")
  })

  test("updateRepositorySettings maps AgentBackendChangeBlockedError for a repository ordinary gate", async () => {
    await runtime.dispose()
    runtime = makeRuntime({
      updateRepositorySettings: () =>
        Effect.fail(
          new AgentBackendChangeBlockedError({
            message:
              "Cannot change Repository Agent Backend while 1 Work Item(s) are unfinished on this Repository",
            unfinishedWorkItemCount: 1,
            scope: "repository",
            repositoryId: repository.id,
          }),
        ),
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) { selectedAgentBackend }
        }`,
        variables: {
          input: {
            repositoryId: repository.id,
            paused: true,
            selectedAgentBackend: "grok",
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
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message:
            "Cannot change Repository Agent Backend while 1 Work Item(s) are unfinished on this Repository",
          extensions: {
            code: "AGENT_BACKEND_CHANGE_BLOCKED",
            unfinishedWorkItemCount: 1,
            scope: "repository",
            repositoryId: repository.id,
          },
        }),
      ],
    })
  })

  test("reports ambient GitLab credential status when no vault secret exists", async () => {
    const gitlabRepository = {
      ...repository,
      forge: "gitlab" as const,
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
      },
      {
        findSecrets: (inputs) =>
          Effect.succeed(
            inputs.map(({ provider }) => {
              if (provider === "github") {
                throw new Error(
                  "must not inspect GitHub credentials for GitLab",
                )
              }
              return null
            }),
          ),
      },
      {},
      {},
      {},
      {},
      {},
      {
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
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
        githubTokenSecretName:
          "GITLAB_TOKEN_GIT_DRUPALCODE_ORG_PROJECT_OAUTH_CLIENT",
        githubTokenCreationUrl:
          "https://git.drupalcode.org/-/user_settings/personal_access_tokens",
      },
    ])
  })

  test("reports vault-backed GitLab credential status", async () => {
    const gitlabRepository = {
      ...repository,
      forge: "gitlab" as const,
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
      },
      {
        findSecrets: (inputs) =>
          Effect.succeed(
            inputs.map(({ provider, account }) =>
              provider === "gitlab" &&
              account === "git.drupalcode.org/project/oauth_client"
                ? "GITLAB_TOKEN_CUSTOM"
                : null,
            ),
          ),
      },
      {},
      {},
      {},
      {},
      {},
      {
        hasCredentials: () =>
          Effect.die("must not consult ambient when vault has the secret"),
        hasAmbientCredentials: () =>
          Effect.die("must not consult ambient when vault has the secret"),
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

    expect(await response.json()).toEqual({
      data: {
        repositoryCredentials: [
          {
            repositoryId: repository.id,
            configured: true,
            githubTokenSecretName: "GITLAB_TOKEN_CUSTOM",
            githubTokenCreationUrl:
              "https://git.drupalcode.org/-/user_settings/personal_access_tokens",
          },
        ],
      },
    })
  })

  test("opens Keymaxxer setup for a missing GitLab repository token", async () => {
    const gitlabRepository = {
      ...repository,
      forge: "gitlab" as const,
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    }
    let tokenName: string | null = null
    let addCalls = 0
    let addedInput: Parameters<KeymaxxerServiceShape["addSecret"]>[0] | null =
      null
    const ensured: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
      },
      {
        findSecret: () => Effect.succeed(tokenName),
        addSecret: (input) =>
          Effect.sleep("10 millis").pipe(
            Effect.map(() => {
              addCalls += 1
              addedInput = input
              tokenName = "RENAMED_GITLAB_TOKEN"
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
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation AddToken($repositoryId: ID!) {
          addRepositoryGitLabToken(repositoryId: $repositoryId) {
            repositoryId configured githubTokenSecretName
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        addRepositoryGitLabToken: {
          repositoryId: repository.id,
          configured: true,
          githubTokenSecretName: "RENAMED_GITLAB_TOKEN",
        },
      },
    })
    expect(addCalls).toBe(1)
    expect(addedInput).toEqual({
      name: "GITLAB_TOKEN_GIT_DRUPALCODE_ORG_PROJECT_OAUTH_CLIENT",
      provider: "gitlab",
      account: "git.drupalcode.org/project/oauth_client",
      environment: "prod",
      access: "read-write",
      description:
        "GitLab personal access token for Ready for Agent on git.drupalcode.org/project/oauth_client",
      tags: "ready-for-agent,harness,gitlab",
    })
    expect(ensured).toEqual([repository.id])
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

  test("pullRequestCount uses GitLab open non-draft MRs for GitLab Repositories", async () => {
    await runtime.dispose()
    const gitlabRepository = makeRepositoryRecord({
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
      localPath: "/repos/oauth-client",
    })
    let openNonDraft = 2
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
      },
      {},
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
      data: {
        repositories: [{ id: gitlabRepository.id, pullRequestCount: 2 }],
      },
    })

    openNonDraft = 5
    const second = await createGraphqlApi(runtime).fetch(graphqlRequest(query))
    expect(await second.json()).toEqual({
      data: {
        repositories: [{ id: gitlabRepository.id, pullRequestCount: 5 }],
      },
    })
  })

  test("repositories without pullRequestCount does not invoke GitHub counting", async () => {
    await runtime.dispose()
    let countCalls = 0
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
        countOpenNonDraftPullRequests: () => {
          countCalls += 1
          return Effect.succeed(9)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          repositories {
            id
            projectPath
            paused
            blockingUnfinishedWorkItemCount
          }
        }`,
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        repositories: [
          {
            id: repository.id,
            projectPath: repository.projectPath,
            paused: repository.paused,
            blockingUnfinishedWorkItemCount: 0,
          },
        ],
      },
    })
    expect(countCalls).toBe(0)
  })

  test("base repositories query completes while pullRequestCount is held pending", async () => {
    await runtime.dispose()
    let releaseCount: (() => void) | undefined
    const countHeld = new Promise<void>((resolve) => {
      releaseCount = resolve
    })
    let countStarted = false
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
        countOpenNonDraftPullRequests: () =>
          Effect.gen(function* () {
            countStarted = true
            yield* Effect.promise(() => countHeld)
            return 4
          }),
      },
    )

    const api = createGraphqlApi(runtime)

    const baseResponsePromise = api.fetch(
      graphqlRequest({
        query: `query {
          repositories {
            id
            projectPath
            blockingUnfinishedWorkItemCount
          }
        }`,
      }),
    )

    const countResponsePromise = api.fetch(
      graphqlRequest({
        query: `query {
          repositories { id pullRequestCount }
        }`,
      }),
    )

    // Base Configured Repositories selection must finish without awaiting count.
    const baseResponse = await baseResponsePromise
    expect(await baseResponse.json()).toEqual({
      data: {
        repositories: [
          {
            id: repository.id,
            projectPath: repository.projectPath,
            blockingUnfinishedWorkItemCount: 0,
          },
        ],
      },
    })

    // Allow the held count request a brief moment to start, then release it.
    await Bun.sleep(20)
    expect(countStarted).toBe(true)
    releaseCount?.()
    const countResponse = await countResponsePromise
    expect(await countResponse.json()).toEqual({
      data: {
        repositories: [{ id: repository.id, pullRequestCount: 4 }],
      },
    })
  })

  test("pullRequestCount leaves a GitHub-unavailable observation unavailable", async () => {
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
    expect(await response.json()).toMatchObject({
      data: null,
      errors: [{}],
    })
  })

  test("pullRequestCount reports GitHub throttling instead of a successful zero", async () => {
    const retryAt = Date.parse("2026-08-07T12:00:00.000Z")
    await runtime.dispose()
    runtime = makeRuntime(
      { listRepositories: Effect.succeed([repository]) },
      {},
      {},
      {},
      {},
      {},
      {
        countOpenNonDraftPullRequests: () =>
          Effect.fail(
            new GitHubThrottledError({ retryAt, usedFallback: false }),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { repositories { pullRequestCount } }`,
      }),
    )
    expect(await response.json()).toMatchObject({
      data: null,
      errors: [
        {
          extensions: { code: "GITHUB_THROTTLED", retryAt },
        },
      ],
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
            provider { id label }
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
            provider: null,
          },
          {
            backend: { id: "grok", label: "grok" },
            kind: "READY",
            reason: null,
            models: [{ id: "grok-code" }],
            provider: null,
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
            provider { id label }
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
          provider: null,
        },
      },
    })
    expect(rechecked).toEqual(["grok"])
  })

  test("propagates optional Agent Backend provider on status, preview, and recheck", async () => {
    // Issue #819: GraphQL exposes Claude provider identity without inventing it.
    const bedrockProvider = { id: "bedrock", label: "Amazon Bedrock" }
    const claudeStatus = readyRuntimeStatus(
      [{ id: "sonnet", thinkingLevels: ["low", "medium", "high"] }],
      "claude",
      bedrockProvider,
    )
    const previewed: string[] = []
    const rechecked: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        listStatuses: Effect.succeed([claudeStatus]),
        getBackendStatus: (backendId) =>
          Effect.succeed(backendId === "claude" ? claudeStatus : null),
        getStatus: Effect.succeed(toAgentBackendStatus(claudeStatus)),
        recheck: (backendId) => {
          rechecked.push(backendId)
          return Effect.succeed(
            backendId === "claude" ? claudeStatus : readyRuntimeStatus(),
          )
        },
        preview: (backendId) => {
          previewed.push(backendId)
          if (backendId === "claude") {
            return Effect.succeed({
              backend: claudeStatus.backend,
              kind: "ready" as const,
              reason: null,
              models: claudeStatus.models,
              provider: bedrockProvider,
              warnings: claudeStatus.warnings,
            })
          }
          return Effect.succeed({
            backend: { id: "opencode", label: "OpenCode" },
            kind: "ready" as const,
            reason: null,
            models: defaultModels,
            provider: null,
            warnings: [],
          })
        },
      },
    )

    const statusResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          agentBackendStatuses {
            backend { id label }
            kind
            provider { id label }
          }
          agentBackendStatus {
            backend { id }
            provider { id label }
          }
        }`,
      }),
    )
    expect(await statusResponse.json()).toEqual({
      data: {
        agentBackendStatuses: [
          {
            backend: { id: "claude", label: "claude" },
            kind: "READY",
            provider: bedrockProvider,
          },
        ],
        agentBackendStatus: {
          backend: { id: "claude" },
          provider: bedrockProvider,
        },
      },
    })

    const previewResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          previewAgentBackend(backendId: "claude") {
            backend { id label }
            kind
            provider { id label }
          }
          openCode: previewAgentBackend(backendId: "opencode") {
            backend { id }
            provider { id label }
          }
        }`,
      }),
    )
    expect(await previewResponse.json()).toEqual({
      data: {
        previewAgentBackend: {
          backend: { id: "claude", label: "claude" },
          kind: "READY",
          provider: bedrockProvider,
        },
        openCode: {
          backend: { id: "opencode" },
          provider: null,
        },
      },
    })
    expect(previewed).toEqual(["claude", "opencode"])

    const recheckResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          recheckAgentBackend(backendId: "claude") {
            backend { id }
            kind
            provider { id label }
          }
        }`,
      }),
    )
    expect(await recheckResponse.json()).toEqual({
      data: {
        recheckAgentBackend: {
          backend: { id: "claude" },
          kind: "READY",
          provider: bedrockProvider,
        },
      },
    })
    expect(rechecked).toEqual(["claude"])
  })

  test("exposes Claude Code Bedrock configuration mode on agentBackends without process env", async () => {
    // Issue #828: CLAUDE_CODE_USE_BEDROCK=1 renames the selectable Claude option
    // and sets configurationMode; browser never sees raw env or secrets.
    const firstParty = await createGraphqlApi(runtime, {
      environment: {},
    }).fetch(
      graphqlRequest({
        query: `query {
          agentBackends { id label configurationMode }
        }`,
      }),
    )
    const firstPartyJson = (await firstParty.json()) as {
      data: {
        agentBackends: ReadonlyArray<{
          id: string
          label: string
          configurationMode: string | null
        }>
      }
    }
    expect(
      firstPartyJson.data.agentBackends.find((entry) => entry.id === "claude"),
    ).toEqual({
      id: "claude",
      label: "Claude Code",
      configurationMode: null,
    })
    expect(
      firstPartyJson.data.agentBackends.find(
        (entry) => entry.id === "opencode",
      ),
    ).toEqual({
      id: "opencode",
      label: "OpenCode",
      configurationMode: null,
    })
    // Response must not echo process environment keys or secret material.
    expect(JSON.stringify(firstPartyJson)).not.toContain(
      "CLAUDE_CODE_USE_BEDROCK",
    )
    expect(JSON.stringify(firstPartyJson)).not.toContain("AWS_SECRET")

    const bedrock = await createGraphqlApi(runtime, {
      environment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
    }).fetch(
      graphqlRequest({
        query: `query {
          agentBackends { id label configurationMode }
        }`,
      }),
    )
    const bedrockJson = (await bedrock.json()) as {
      data: {
        agentBackends: ReadonlyArray<{
          id: string
          label: string
          configurationMode: string | null
        }>
      }
    }
    expect(
      bedrockJson.data.agentBackends.find((entry) => entry.id === "claude"),
    ).toEqual({
      id: "claude",
      label: "Claude Code Bedrock",
      configurationMode: "bedrock",
    })
    expect(JSON.stringify(bedrockJson)).not.toContain("CLAUDE_CODE_USE_BEDROCK")
    expect(JSON.stringify(bedrockJson)).not.toContain("must-not-leak")
    expect(JSON.stringify(bedrockJson)).not.toContain("AWS_SECRET")
  })

  test("propagates Bedrock profile catalog and discovery warnings on status, preview, and recheck", async () => {
    // Issues #820 / #821: profile IDs/ARNs, friendly names, kinds, and non-fatal
    // warnings pass through without reinterpretation.
    const bedrockProvider = { id: "bedrock", label: "Amazon Bedrock" }
    const warning =
      "Could not list Amazon Bedrock inference profiles: access denied. Fix AWS configuration (credentials, region, bedrock:ListInferenceProfiles), then Recheck Agent Backend."
    const applicationArn =
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"
    const profileModels = [
      {
        id: "us.anthropic.claude-sonnet-4-6",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        name: "US Anthropic Claude Sonnet 4.6",
        kind: "SYSTEM_DEFINED",
      },
      {
        id: applicationArn,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        name: "My Org Sonnet",
        kind: "APPLICATION",
      },
    ]
    const claudeStatus = readyRuntimeStatus(
      profileModels,
      "claude",
      bedrockProvider,
      [warning],
    )
    const rechecked: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {},
      {
        listStatuses: Effect.succeed([claudeStatus]),
        getBackendStatus: (backendId) =>
          Effect.succeed(backendId === "claude" ? claudeStatus : null),
        getStatus: Effect.succeed(toAgentBackendStatus(claudeStatus)),
        recheck: (backendId) => {
          rechecked.push(backendId)
          return Effect.succeed(
            backendId === "claude" ? claudeStatus : readyRuntimeStatus(),
          )
        },
        preview: (backendId) => {
          if (backendId === "claude") {
            return Effect.succeed({
              backend: claudeStatus.backend,
              kind: "ready" as const,
              reason: null,
              models: claudeStatus.models,
              provider: bedrockProvider,
              warnings: claudeStatus.warnings,
            })
          }
          return Effect.succeed({
            backend: { id: "opencode", label: "OpenCode" },
            kind: "ready" as const,
            reason: null,
            models: defaultModels,
            provider: null,
            warnings: [],
          })
        },
      },
    )

    const statusResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          agentBackendStatuses {
            backend { id }
            kind
            models { id thinkingLevels name kind }
            warnings
            provider { id label }
          }
        }`,
      }),
    )
    expect(await statusResponse.json()).toEqual({
      data: {
        agentBackendStatuses: [
          {
            backend: { id: "claude" },
            kind: "READY",
            models: profileModels,
            warnings: [warning],
            provider: bedrockProvider,
          },
        ],
      },
    })

    const previewResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          previewAgentBackend(backendId: "claude") {
            kind
            models { id name kind }
            warnings
          }
        }`,
      }),
    )
    expect(await previewResponse.json()).toEqual({
      data: {
        previewAgentBackend: {
          kind: "READY",
          models: [
            {
              id: "us.anthropic.claude-sonnet-4-6",
              name: "US Anthropic Claude Sonnet 4.6",
              kind: "SYSTEM_DEFINED",
            },
            {
              id: applicationArn,
              name: "My Org Sonnet",
              kind: "APPLICATION",
            },
          ],
          warnings: [warning],
        },
      },
    })

    const recheckResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation {
          recheckAgentBackend(backendId: "claude") {
            kind
            models { id name kind }
            warnings
          }
        }`,
      }),
    )
    expect(await recheckResponse.json()).toEqual({
      data: {
        recheckAgentBackend: {
          kind: "READY",
          models: [
            {
              id: "us.anthropic.claude-sonnet-4-6",
              name: "US Anthropic Claude Sonnet 4.6",
              kind: "SYSTEM_DEFINED",
            },
            {
              id: applicationArn,
              name: "My Org Sonnet",
              kind: "APPLICATION",
            },
          ],
          warnings: [warning],
        },
      },
    })
    expect(rechecked).toEqual(["claude"])
  })

  test("models query exposes executable id separately from friendly name metadata (issue #821)", async () => {
    const applicationArn =
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"
    const profileModels = [
      {
        id: "us.anthropic.claude-sonnet-4-6",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        name: "US Anthropic Claude Sonnet 4.6",
        kind: "SYSTEM_DEFINED",
      },
      {
        id: applicationArn,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        name: "My Org Sonnet",
        kind: "APPLICATION",
      },
    ]
    const claudeStatus = readyRuntimeStatus(profileModels, "claude", {
      id: "bedrock",
      label: "Amazon Bedrock",
    })
    await runtime.dispose()
    runtime = makeRuntime(
      {
        getConfig: Effect.succeed({
          ...config,
          selectedAgentBackend: "claude",
          defaultModel: "us.anthropic.claude-sonnet-4-6",
        }),
      },
      {},
      {},
      {},
      {
        listStatuses: Effect.succeed([claudeStatus]),
        getBackendStatus: (backendId) =>
          Effect.succeed(backendId === "claude" ? claudeStatus : null),
        getStatus: Effect.succeed(toAgentBackendStatus(claudeStatus)),
      },
    )

    const modelsResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query { models { id name kind thinkingLevels } }`,
      }),
    )
    const body = await modelsResponse.json()
    // Executable values stay on id; name/kind are presentation-only.
    expect(body).toEqual({
      data: {
        models: profileModels,
      },
    })
    expect(body.data.models[0].id).toBe("us.anthropic.claude-sonnet-4-6")
    expect(body.data.models[0].name).not.toBe(body.data.models[0].id)
    expect(body.data.models[1].id).toBe(applicationArn)
    expect(body.data.models[1].kind).toBe("APPLICATION")
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
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
              message:
                "No build model set for acme/widgets on Agent Backend 'Claude Code'. Available: haiku, sonnet. Set one in Settings, or per repository.",
            }),
          ),
      },
    )
    const missingModel = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )
    expect(await missingModel.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message:
            "No build model set for acme/widgets on Agent Backend 'Claude Code'. Available: haiku, sonnet. Set one in Settings, or per repository.",
          extensions: expect.objectContaining({
            code: "BUILD_MODEL_NOT_CONFIGURED",
          }),
        }),
      ],
    })
  })

  test("implementWith projects an explicit profile and Same as build intent", async () => {
    const profiled = {
      ...workItem,
      executionProfile: {
        agentBackend: "opencode",
        build: { model: "build-model", thinkingLevel: "high" },
        review: { kind: "same_as_build" as const },
      },
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementWith: (repositoryId, issueNumber, profile, options) => {
          expect(repositoryId).toBe(repository.id)
          expect(issueNumber).toBe(issue.issueNumber)
          expect(profile).toEqual({
            agentBackendId: "opencode",
            buildModel: "build-model",
            buildThinkingLevel: "high",
            reviewSameAsBuild: true,
            reviewModel: null,
            reviewThinkingLevel: null,
          })
          expect(options).toBeUndefined()
          return Effect.succeed({
            ...profiled,
            autoMergeOverride: null,
            pauseBeforeStep: null,
          })
        },
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementWith(
          $repositoryId: ID!
          $issueNumber: Int!
          $profile: ExplicitWorkItemExecutionProfileInput!
        ) {
          implementWith(
            repositoryId: $repositoryId
            issueNumber: $issueNumber
            profile: $profile
          ) {
            id
            executionProfile {
              backend { id label }
              buildModel
              buildThinkingLevel
              reviewSameAsBuild
              reviewModel
              reviewThinkingLevel
            }
            autoMergeOverride
            pauseBeforeStep
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
          profile: {
            agentBackendId: "opencode",
            buildModel: "build-model",
            buildThinkingLevel: "high",
            reviewSameAsBuild: true,
          },
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        implementWith: {
          id: workItem.id,
          executionProfile: {
            backend: { id: "opencode", label: "OpenCode" },
            buildModel: "build-model",
            buildThinkingLevel: "high",
            reviewSameAsBuild: true,
            reviewModel: "build-model",
            reviewThinkingLevel: "high",
          },
          autoMergeOverride: null,
          pauseBeforeStep: null,
        },
      },
    })
  })

  test("implementWith forwards concrete options for both boolean values", async () => {
    const profiled = {
      ...workItem,
      executionProfile: {
        agentBackend: "opencode",
        build: { model: "build-model", thinkingLevel: null },
        review: { kind: "same_as_build" as const },
      },
      autoMergeOverride: true,
      pauseBeforeStep: "commit",
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementWith: (_repositoryId, _issueNumber, _profile, options) => {
          expect(options).toEqual({
            autoMerge: true,
            implementLocally: true,
          })
          return Effect.succeed(profiled)
        },
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementWith(
          $repositoryId: ID!
          $issueNumber: Int!
          $profile: ExplicitWorkItemExecutionProfileInput!
          $options: ImplementWithOptionsInput
        ) {
          implementWith(
            repositoryId: $repositoryId
            issueNumber: $issueNumber
            profile: $profile
            options: $options
          ) {
            autoMergeOverride
            pauseBeforeStep
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
          profile: {
            agentBackendId: "opencode",
            buildModel: "build-model",
            reviewSameAsBuild: true,
          },
          options: { autoMerge: true, implementLocally: true },
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        implementWith: {
          autoMergeOverride: true,
          pauseBeforeStep: "COMMIT",
        },
      },
    })
  })

  test("implementWith projects a false Auto-merge override without a pause target", async () => {
    const profiled = {
      ...workItem,
      executionProfile: {
        agentBackend: "opencode",
        build: { model: "build-model", thinkingLevel: null },
        review: { kind: "same_as_build" as const },
      },
      autoMergeOverride: false,
      pauseBeforeStep: null,
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementWith: (_repositoryId, _issueNumber, _profile, options) => {
          expect(options).toEqual({
            autoMerge: false,
            implementLocally: false,
          })
          return Effect.succeed(profiled)
        },
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementWith(
          $repositoryId: ID!
          $issueNumber: Int!
          $profile: ExplicitWorkItemExecutionProfileInput!
          $options: ImplementWithOptionsInput
        ) {
          implementWith(
            repositoryId: $repositoryId
            issueNumber: $issueNumber
            profile: $profile
            options: $options
          ) {
            autoMergeOverride
            pauseBeforeStep
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
          profile: {
            agentBackendId: "opencode",
            buildModel: "build-model",
            reviewSameAsBuild: true,
          },
          options: { autoMerge: false, implementLocally: false },
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        implementWith: {
          autoMergeOverride: false,
          pauseBeforeStep: null,
        },
      },
    })
  })

  test("implementNow still omits an execution profile", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.succeed({ ...workItem, executionProfile: null }),
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
            executionProfile { buildModel }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        implementNow: {
          id: workItem.id,
          executionProfile: null,
        },
      },
    })
  })

  test("surfaces Implement With validation errors", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementWith: () =>
          Effect.fail(
            new InvalidExecutionProfileError({
              message:
                "Implement With requires a review Agent Model unless Same as build is selected",
              field: "reviewModel",
            }),
          ),
      },
    )
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementWith(
          $repositoryId: ID!
          $issueNumber: Int!
          $profile: ExplicitWorkItemExecutionProfileInput!
        ) {
          implementWith(
            repositoryId: $repositoryId
            issueNumber: $issueNumber
            profile: $profile
          ) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
          profile: {
            agentBackendId: "opencode",
            buildModel: "build-model",
            reviewSameAsBuild: false,
          },
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message:
            "Implement With requires a review Agent Model unless Same as build is selected",
          extensions: expect.objectContaining({
            code: "INVALID_EXECUTION_PROFILE",
            field: "reviewModel",
          }),
        }),
      ],
    })
  })

  test("repositoryModelPrefs returns backend-scoped Repository prefs without mutating settings", async () => {
    const prefsCalls: Array<{ repositoryId: string; backendId: string }> = []
    await runtime.dispose()
    runtime = makeRuntime({
      getRepositoryBackendModelPrefs: (repositoryId, backendId) => {
        prefsCalls.push({ repositoryId, backendId })
        return Effect.succeed({
          defaultModel: "grok-code",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
        })
      },
    })
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query RepositoryModelPrefs($repositoryId: ID!, $backendId: String!) {
          repositoryModelPrefs(repositoryId: $repositoryId, backendId: $backendId) {
            defaultModel
            defaultThinkingLevel
            reviewModel
            reviewThinkingLevel
          }
        }`,
        variables: {
          repositoryId: repository.id,
          backendId: "grok",
        },
      }),
    )
    expect(await response.json()).toEqual({
      data: {
        repositoryModelPrefs: {
          defaultModel: "grok-code",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
        },
      },
    })
    expect(prefsCalls).toEqual([
      { repositoryId: repository.id, backendId: "grok" },
    ])
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
            id repositoryId issueNumber title body url state githubCreatedAt
            issueAuthor
            parent { issueNumber issueUrl }
            hasChildren
            blockedBy { issueNumber issueUrl }
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
            issueNumber: issue.issueNumber,
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
      issueNumber: number,
      overrides: Partial<typeof issue> = {},
    ) => ({
      ...issue,
      id: `issue-${issueNumber}`,
      issueNumber,
      title: `Issue ${issueNumber}`,
      url: `https://github.com/acme/widgets/issues/${issueNumber}`,
      blockedBy: [],
      ...overrides,
    })
    const parent = makeIssue(10, { hasChildren: true })
    const parentReference = {
      issueNumber: 10,
      issueUrl: parent.url,
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
            issueNumber hasChildren
            parent { issueNumber }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        issues: [
          { issueNumber: 10, hasChildren: true, parent: null },
          {
            issueNumber: 14,
            hasChildren: false,
            parent: { issueNumber: 10 },
          },
          {
            issueNumber: 11,
            hasChildren: false,
            parent: { issueNumber: 10 },
          },
          {
            issueNumber: 13,
            hasChildren: false,
            parent: { issueNumber: 10 },
          },
          {
            issueNumber: 12,
            hasChildren: false,
            parent: { issueNumber: 10 },
          },
          { issueNumber: 3, hasChildren: false, parent: null },
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
            issues(repositoryId: $repositoryId) { issueNumber }
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
          issues: [{ issueNumber: issue.issueNumber }],
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
        listWorkItemsForIssue: (repositoryId, issueNumber) => {
          receivedArgs = [repositoryId, issueNumber]
          return Effect.succeed([workItem])
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id state stateLabel status statusLabel statusMessage paused canRetry isTerminal
            stateReadyAt createdAt updatedAt
            lifecycleLabels { phase label status durationMs }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
    expect(receivedArgs).toEqual([repository.id, issue.issueNumber])
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage canRetry isTerminal
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            stateLabel: "Status checks",
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
                label: "Status checks: Queued",
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
                label: "Status checks: Needs human",
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state stateLabel status statusLabel paused isTerminal
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state status statusLabel paused isTerminal
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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

  test("projects paused closed-Issue + open-PR stop as Needs human review with reason, not Succeeded", async () => {
    const baseRun = workItem.stepRuns[0]!
    const reason =
      "Issue #42 is closed or no longer present while pull request #101 is still open. Reopen the issue if you want to continue, then Start job."
    const pausedClosedIssue = {
      ...workItem,
      state: "watch_pr_status_checks",
      paused: true,
      pauseBeforeStep: null,
      pullRequestNumber: 101,
      failureCode: null,
      failureMessage: reason,
      holdsWorkerSlot: false,
      stepRuns: [
        { ...baseRun, step: "create_worktree", status: "succeeded" },
        {
          ...baseRun,
          step: "watch_pr_status_checks",
          status: "succeeded",
          reasonCode: "issue_closed_while_pr_open",
          reasonMessage: reason,
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([pausedClosedIssue]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state stateLabel status statusLabel statusMessage paused isTerminal canRetry
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            state: "WATCH_PR_STATUS_CHECKS",
            stateLabel: "Status checks",
            status: "NEEDS_HUMAN_REVIEW",
            statusLabel: "Needs human review",
            statusMessage: reason,
            paused: true,
            isTerminal: false,
            canRetry: false,
            lifecycleLabels: [
              {
                phase: "CREATE_WORKTREE",
                label: "Create worktree: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "GITHUB_STATUS_CHECKS",
                label: "Status checks: Succeeded",
                status: "SUCCEEDED",
              },
            ],
          },
        ],
      },
    })
  })

  test("projects paused closed-Issue + closed-unmerged PR stop as Needs human review with reason, not Succeeded", async () => {
    const baseRun = workItem.stepRuns[0]!
    const reason =
      "Issue #42 is closed or no longer present and pull request #101 was closed without merge. Start job after reopening if you want to continue, or Abandon or Reset."
    const pausedClosedUnmerged = {
      ...workItem,
      state: "investigate_pr_status_checks",
      paused: true,
      pauseBeforeStep: null,
      pullRequestNumber: 101,
      failureCode: null,
      failureMessage: reason,
      holdsWorkerSlot: false,
      stepRuns: [
        { ...baseRun, step: "create_worktree", status: "succeeded" },
        {
          ...baseRun,
          step: "investigate_pr_status_checks",
          status: "succeeded",
          reasonCode: "issue_closed_pr_closed_unmerged",
          reasonMessage: reason,
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed([pausedClosedUnmerged]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state stateLabel status statusLabel statusMessage paused isTerminal canRetry
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            state: "INVESTIGATE_PR_STATUS_CHECKS",
            stateLabel: "Status checks",
            status: "NEEDS_HUMAN_REVIEW",
            statusLabel: "Needs human review",
            statusMessage: reason,
            paused: true,
            isTerminal: false,
            canRetry: false,
            lifecycleLabels: [
              {
                phase: "CREATE_WORKTREE",
                label: "Create worktree: Succeeded",
                status: "SUCCEEDED",
              },
              {
                phase: "GITHUB_STATUS_CHECKS",
                label: "Status checks: Succeeded",
                status: "SUCCEEDED",
              },
            ],
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state status statusLabel statusMessage paused isTerminal
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            stateLabel status statusLabel statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            status statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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

  test("exposes the latest Step Run cause chain as latestStepRunDetail", async () => {
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
          reasonDetail: JSON.stringify({
            causeChain: [
              {
                name: "Error",
                code: "ENOENT",
                message: 'ENOENT: Executable not found in $PATH: "claude"',
              },
            ],
            code: "ENOENT",
          }),
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            status
            statusMessage
            latestStepRunDetail {
              code
              causeChain { name code message }
            }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            status: "FAILED",
            statusMessage: "OpenCode failed to review the Work Item",
            latestStepRunDetail: {
              code: "ENOENT",
              causeChain: [
                {
                  name: "Error",
                  code: "ENOENT",
                  message: 'ENOENT: Executable not found in $PATH: "claude"',
                },
              ],
            },
          },
        ],
      },
    })
  })

  test("projects canRetry and latestStepRunReason for retryable, terminal, Needs Human, and missing detail", async () => {
    const retryableFailed = {
      ...workItem,
      id: "wi-retryable-failed",
      state: "implement",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-retryable-failed",
          workItemId: "wi-retryable-failed",
          step: "implement",
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
          reasonCode: STEP_RUN_REASON.handlerFailed,
          reasonMessage: "OpenCode failed to implement the Work Item issue",
          reasonDetail: JSON.stringify({
            causeChain: [
              {
                name: "Error",
                code: "ENOENT",
                message: 'ENOENT: Executable not found in $PATH: "claude"',
              },
            ],
            code: "ENOENT",
          }),
        },
      ],
    } as WorkItemRecord
    const terminalFailed = {
      ...workItem,
      id: "wi-terminal-failed",
      state: "failed",
      failureCode: "issue_not_open",
      failureMessage: "Issue is not open",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-terminal-failed",
          workItemId: "wi-terminal-failed",
          step: "close_issue",
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
          reasonCode: "issue_not_open",
          reasonMessage: "Issue is not open",
          reasonDetail: null,
        },
      ],
    } as WorkItemRecord
    const retryableNeedsHuman = {
      ...workItem,
      id: "wi-retryable-needs-human",
      state: "needs_human",
      failureCode: "needs_human",
      failureMessage: "Human must review findings",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-retryable-needs-human",
          workItemId: "wi-retryable-needs-human",
          step: "review",
          status: "succeeded",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
          reasonCode: STEP_RUN_REASON.reviewAccepted,
          reasonMessage: "Human must review findings",
          reasonDetail: null,
        },
      ],
    } as WorkItemRecord
    const unavailableDetail = {
      ...workItem,
      id: "wi-unavailable-detail",
      state: "implement",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-unavailable-detail",
          workItemId: "wi-unavailable-detail",
          step: "implement",
          status: "interrupted",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
          reasonCode: STEP_RUN_REASON.interrupted,
          reasonMessage:
            "Lifecycle Step was interrupted before an outcome could be established",
          reasonDetail: null,
        },
      ],
    } as WorkItemRecord

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () =>
          Effect.succeed([
            retryableFailed,
            terminalFailed,
            retryableNeedsHuman,
            unavailableDetail,
          ]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
            state
            status
            canRetry
            isTerminal
            latestStepRunReason {
              code
              message
              detail {
                code
                causeChain { name code message }
              }
            }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: "wi-retryable-failed",
            state: "IMPLEMENT",
            status: "FAILED",
            canRetry: true,
            isTerminal: false,
            latestStepRunReason: {
              code: "handler_failed",
              message: "OpenCode failed to implement the Work Item issue",
              detail: {
                code: "ENOENT",
                causeChain: [
                  {
                    name: "Error",
                    code: "ENOENT",
                    message: 'ENOENT: Executable not found in $PATH: "claude"',
                  },
                ],
              },
            },
          },
          {
            id: "wi-terminal-failed",
            state: "FAILED",
            status: "FAILED",
            canRetry: false,
            isTerminal: true,
            latestStepRunReason: {
              code: "issue_not_open",
              message: "Issue is not open",
              detail: null,
            },
          },
          {
            id: "wi-retryable-needs-human",
            state: "NEEDS_HUMAN",
            status: "NEEDS_HUMAN",
            canRetry: true,
            isTerminal: true,
            latestStepRunReason: {
              code: "review_accepted",
              message: "Human must review findings",
              detail: null,
            },
          },
          {
            id: "wi-unavailable-detail",
            state: "IMPLEMENT",
            status: "INTERRUPTED",
            canRetry: true,
            isTerminal: false,
            latestStepRunReason: {
              code: "interrupted",
              message:
                "Lifecycle Step was interrupted before an outcome could be established",
              detail: null,
            },
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            status statusMessage
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
            id issueNumber state
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
            issueNumber: issue.issueNumber,
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
      pullRequestNumber: 212,
    } as WorkItemRecord
    const withoutPr = {
      ...workItem,
      id: makeWorkItemId(),
      pullRequestNumber: null,
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
            id pullRequestNumber
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
            pullRequestNumber: 212,
          },
          {
            id: withoutPr.id,
            pullRequestNumber: null,
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

  test("filters Completed Work Items to rolling last 24 hours without a fixed limit", async () => {
    const nowMs = Date.now()
    const hourMs = 60 * 60 * 1000
    const completedRecent = Array.from({ length: 18 }, (_, index) => {
      const readyAt = nowMs - index * 10 * 60 * 1000
      return {
        ...workItem,
        id: makeWorkItemId(),
        state: (index % 2 === 0 ? "complete" : "abandoned") as
          | "complete"
          | "abandoned",
        createdAt: new Date(readyAt - hourMs),
        updatedAt: new Date(readyAt),
        stateReadyAt: new Date(readyAt),
        stepRuns: [],
      }
    })
    const completedTooOld = {
      ...workItem,
      id: makeWorkItemId(),
      state: "complete" as const,
      createdAt: new Date(nowMs - 48 * hourMs),
      updatedAt: new Date(nowMs - 25 * hourMs),
      stateReadyAt: new Date(nowMs - 25 * hourMs),
      stepRuns: [],
    }
    const needsHuman = {
      ...workItem,
      id: makeWorkItemId(),
      state: "needs_human" as const,
      createdAt: new Date(nowMs - 1000),
      updatedAt: new Date(nowMs - 1000),
      stateReadyAt: new Date(nowMs - 1000),
      stepRuns: [],
    }
    const terminalFailed = {
      ...workItem,
      id: makeWorkItemId(),
      state: "failed" as const,
      createdAt: new Date(nowMs - 2000),
      updatedAt: new Date(nowMs - 2000),
      stateReadyAt: new Date(nowMs - 2000),
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
            ...completedRecent,
            completedTooOld,
            needsHuman,
            terminalFailed,
          ]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $listKind: WorkItemsListKind) {
          workItems(repositoryId: $repositoryId, listKind: $listKind) {
            id state
          }
        }`,
        variables: {
          repositoryId: repository.id,
          listKind: "COMPLETED",
        },
      }),
    )

    const body = (await response.json()) as {
      data: { workItems: readonly { id: string; state: string }[] }
    }
    expect(body.data.workItems).toHaveLength(18)
    expect(body.data.workItems.map((item) => item.id)).not.toContain(
      completedTooOld.id,
    )
    expect(
      body.data.workItems.every(
        (item) => item.state !== "NEEDS_HUMAN" && item.state !== "FAILED",
      ),
    ).toBe(true)
    expect(body.data.workItems.map((item) => item.id)).toEqual(
      completedRecent
        .slice()
        .sort(
          (left, right) =>
            right.stateReadyAt.getTime() - left.stateReadyAt.getTime(),
        )
        .map((item) => item.id),
    )
  })

  test("paginates historical completedWorkItems across repositories without the 24h window", async () => {
    const nowMs = Date.now()
    const hourMs = 60 * 60 * 1000
    const completed = Array.from({ length: 25 }, (_, index) => {
      const readyAt = nowMs - index * hourMs
      return {
        ...workItem,
        id: makeWorkItemId(),
        repositoryId: index % 2 === 0 ? repository.id : "repo-other",
        issueNumber: index + 1,
        state: (index % 2 === 0 ? "complete" : "abandoned") as
          | "complete"
          | "abandoned",
        createdAt: new Date(readyAt - hourMs),
        updatedAt: new Date(readyAt),
        stateReadyAt: new Date(readyAt),
        stepRuns: [],
      }
    })
    // Older than 24 h — still in historical list (index 24 => 24 h ago is
    // boundary; add an explicit 48 h item).
    const completedTooOldForJobsTab = {
      ...workItem,
      id: makeWorkItemId(),
      repositoryId: "repo-other",
      issueNumber: 99,
      state: "complete" as const,
      createdAt: new Date(nowMs - 72 * hourMs),
      updatedAt: new Date(nowMs - 48 * hourMs),
      stateReadyAt: new Date(nowMs - 48 * hourMs),
      stepRuns: [],
    }
    const implementing = {
      ...workItem,
      id: makeWorkItemId(),
      state: "implement" as const,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
      stateReadyAt: new Date(nowMs),
      stepRuns: [],
    }

    let lastListArgs: { page: number; pageSize: number } | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listCompletedWorkItems: (options) => {
          lastListArgs = options
          const all = [...completed, completedTooOldForJobsTab, implementing]
            .filter(
              (item) => item.state === "complete" || item.state === "abandoned",
            )
            .sort(
              (left, right) =>
                right.stateReadyAt.getTime() - left.stateReadyAt.getTime(),
            )
          const offset = (options.page - 1) * options.pageSize
          return Effect.succeed({
            items: all.slice(offset, offset + options.pageSize),
            page: options.page,
            pageSize: options.pageSize,
            totalCount: all.length,
          })
        },
      },
    )

    const firstResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Completed($page: Int, $pageSize: Int) {
          completedWorkItems(page: $page, pageSize: $pageSize) {
            items { id state repositoryId }
            page
            pageSize
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }`,
        variables: { page: 1, pageSize: 20 },
      }),
    )
    const firstBody = (await firstResponse.json()) as {
      data: {
        completedWorkItems: {
          items: readonly {
            id: string
            state: string
            repositoryId: string
          }[]
          page: number
          pageSize: number
          totalCount: number
          hasNextPage: boolean
          hasPreviousPage: boolean
        }
      }
    }

    expect(lastListArgs).toEqual({ page: 1, pageSize: 20 })
    expect(firstBody.data.completedWorkItems.page).toBe(1)
    expect(firstBody.data.completedWorkItems.pageSize).toBe(20)
    expect(firstBody.data.completedWorkItems.totalCount).toBe(26)
    expect(firstBody.data.completedWorkItems.items).toHaveLength(20)
    expect(firstBody.data.completedWorkItems.hasNextPage).toBe(true)
    expect(firstBody.data.completedWorkItems.hasPreviousPage).toBe(false)
    expect(
      firstBody.data.completedWorkItems.items.some(
        (item) => item.id === completedTooOldForJobsTab.id,
      ),
    ).toBe(false) // oldest is on a later page
    expect(
      firstBody.data.completedWorkItems.items.every(
        (item) => item.state === "COMPLETE" || item.state === "ABANDONED",
      ),
    ).toBe(true)

    const secondResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Completed($page: Int, $pageSize: Int) {
          completedWorkItems(page: $page, pageSize: $pageSize) {
            items { id }
            page
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }`,
        variables: { page: 2, pageSize: 20 },
      }),
    )
    const secondBody = (await secondResponse.json()) as {
      data: {
        completedWorkItems: {
          items: readonly { id: string }[]
          page: number
          totalCount: number
          hasNextPage: boolean
          hasPreviousPage: boolean
        }
      }
    }
    expect(lastListArgs).toEqual({ page: 2, pageSize: 20 })
    expect(secondBody.data.completedWorkItems.items).toHaveLength(6)
    expect(secondBody.data.completedWorkItems.hasNextPage).toBe(false)
    expect(secondBody.data.completedWorkItems.hasPreviousPage).toBe(true)
    expect(
      secondBody.data.completedWorkItems.items.map((item) => item.id),
    ).toContain(completedTooOldForJobsTab.id)

    // Defaults: page 1, pageSize 21 (fills 3-column completed grid)
    const defaultResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          completedWorkItems {
            page
            pageSize
            totalCount
          }
        }`,
      }),
    )
    const defaultBody = (await defaultResponse.json()) as {
      data: {
        completedWorkItems: {
          page: number
          pageSize: number
          totalCount: number
        }
      }
    }
    expect(lastListArgs).toEqual({ page: 1, pageSize: 21 })
    expect(defaultBody.data.completedWorkItems.page).toBe(1)
    expect(defaultBody.data.completedWorkItems.pageSize).toBe(21)
  })

  test("normalizes completedWorkItems page and pageSize edge cases", async () => {
    let lastListArgs: { page: number; pageSize: number } | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listCompletedWorkItems: (options) => {
          lastListArgs = options
          return Effect.succeed({
            items: [],
            page: options.page,
            pageSize: options.pageSize,
            totalCount: 0,
          })
        },
      },
    )

    const cases: readonly {
      readonly variables: { page?: number; pageSize?: number }
      readonly expected: { page: number; pageSize: number }
    }[] = [
      {
        variables: { page: 0, pageSize: 20 },
        expected: { page: 1, pageSize: 20 },
      },
      {
        variables: { page: -2, pageSize: 20 },
        expected: { page: 1, pageSize: 20 },
      },
      // GraphQL Int variables only — fractional values are not part of the contract.
      {
        variables: { page: 2, pageSize: 0 },
        expected: { page: 2, pageSize: 21 },
      },
      {
        variables: { page: 3, pageSize: -5 },
        expected: { page: 3, pageSize: 21 },
      },
      {
        variables: { page: 1, pageSize: 500 },
        expected: { page: 1, pageSize: 100 },
      },
    ]

    for (const { variables, expected } of cases) {
      const response = await createGraphqlApi(runtime).fetch(
        graphqlRequest({
          query: `query Completed($page: Int, $pageSize: Int) {
            completedWorkItems(page: $page, pageSize: $pageSize) {
              page
              pageSize
            }
          }`,
          variables,
        }),
      )
      const body = (await response.json()) as {
        data: {
          completedWorkItems: { page: number; pageSize: number }
        }
      }
      expect(lastListArgs).toEqual(expected)
      expect(body.data.completedWorkItems).toEqual(expected)
    }
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
      issueNumber: 120,
      state: "needs_human" as const,
      stepRuns: [],
    }
    const failedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 122,
      state: "failed" as const,
      stepRuns: [],
    }
    const unfinishedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 121,
      state: "implement" as const,
      stepRuns: [],
    }
    const completeOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 123,
      state: "complete" as const,
      stepRuns: [],
    }
    const abandonedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 124,
      state: "abandoned" as const,
      stepRuns: [],
    }
    const terminalRelevant = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: issue.issueNumber,
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
            id issueNumber state
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
            issueNumber: 120,
            state: "NEEDS_HUMAN",
          },
          {
            id: unfinishedOrphan.id,
            issueNumber: 121,
            state: "IMPLEMENT",
          },
          {
            id: completeOrphan.id,
            issueNumber: 123,
            state: "COMPLETE",
          },
          {
            id: abandonedOrphan.id,
            issueNumber: 124,
            state: "ABANDONED",
          },
          {
            id: terminalRelevant.id,
            issueNumber: issue.issueNumber,
            state: "COMPLETE",
          },
        ],
      },
    })
  })

  test("keeps complete and abandoned Work Items in COMPLETED when Issue is absent", async () => {
    const nowMs = Date.now()
    const completeOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 201,
      issueTitle: "Completed issue title",
      state: "complete" as const,
      createdAt: new Date(nowMs - 3_600_000),
      updatedAt: new Date(nowMs - 2_000_000),
      stateReadyAt: new Date(nowMs - 2_000_000),
      stepRuns: [],
    }
    const abandonedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 202,
      issueTitle: null,
      state: "abandoned" as const,
      createdAt: new Date(nowMs - 1_800_000),
      updatedAt: new Date(nowMs - 1_000_000),
      stateReadyAt: new Date(nowMs - 1_000_000),
      stepRuns: [],
    }
    const failedOrphan = {
      ...workItem,
      id: makeWorkItemId(),
      issueNumber: 203,
      state: "failed" as const,
      createdAt: new Date(nowMs - 500_000),
      updatedAt: new Date(nowMs - 500_000),
      stateReadyAt: new Date(nowMs - 500_000),
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
            id issueNumber issueTitle state
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
            issueNumber: 202,
            issueTitle: null,
            state: "ABANDONED",
          },
          {
            id: completeOrphan.id,
            issueNumber: 201,
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
        implementNow: (repositoryId, issueNumber) => {
          receivedArgs = [repositoryId, issueNumber]
          return Effect.succeed(workItem)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id state
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
    expect(receivedArgs).toEqual([repository.id, issue.issueNumber])
  })

  test("starts a Work Item for Implement Locally", async () => {
    let receivedArgs: readonly [string, number] | undefined
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementLocally: (repositoryId, issueNumber) => {
          receivedArgs = [repositoryId, issueNumber]
          return Effect.succeed(workItem)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementLocally($repositoryId: ID!, $issueNumber: Int!) {
          implementLocally(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id state
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
    expect(receivedArgs).toEqual([repository.id, issue.issueNumber])
  })

  test("implements all with auto-merge for a Parent Issue's covered children", async () => {
    let receivedArgs: readonly [string, number] | undefined
    const actionableChild = {
      ...workItem,
      id: makeWorkItemId(),
      mergeMode: "always" as const,
      issueNumber: 43,
    }
    const blockedChild = {
      ...workItem,
      id: makeWorkItemId(),
      mergeMode: "always" as const,
      issueNumber: 44,
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
        implementAllWithAutoMerge: (repositoryId, issueNumber) => {
          receivedArgs = [repositoryId, issueNumber]
          return Effect.succeed([actionableChild, blockedChild])
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementAllWithAutoMerge($repositoryId: ID!, $issueNumber: Int!) {
          implementAllWithAutoMerge(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id issueNumber mergeMode state status statusLabel
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: 10,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        implementAllWithAutoMerge: [
          {
            id: actionableChild.id,
            issueNumber: 43,
            mergeMode: "ALWAYS",
            state: "CREATE_WORKTREE",
            status: "RUNNING",
            statusLabel: "Running",
          },
          {
            id: blockedChild.id,
            issueNumber: 44,
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
            issueNumber: 10,
            reason: "Parent Issue #10 has no open Child Issues",
          } as never),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementAllWithAutoMerge($repositoryId: ID!, $issueNumber: Int!) {
          implementAllWithAutoMerge(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: 10,
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
        queue: (repositoryId, issueNumber) => {
          receivedArgs = [repositoryId, issueNumber]
          return Effect.succeed(held)
        },
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $issueNumber: Int!) {
          queue(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id state status statusLabel statusMessage canRetry isTerminal
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
    expect(receivedArgs).toEqual([repository.id, issue.issueNumber])
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
              issueNumber: issue.issueNumber,
            }),
          ),
      },
    )
    const notBlocked = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $issueNumber: Int!) {
          queue(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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
              issueNumber: issue.issueNumber,
              workItemId: workItem.id,
            }),
          ),
      },
    )
    const unfinished = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Queue($repositoryId: ID!, $issueNumber: Int!) {
          queue(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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

  test("lists Intake Candidates ordered with IMPLEMENT_NOW then QUEUE", async () => {
    const actionable = {
      ...issue,
      id: "issue-actionable",
      issueNumber: 12,
      title: "Actionable leaf",
      url: "https://github.com/acme/widgets/issues/12",
      blockedBy: [],
    }
    const blocked = {
      ...issue,
      id: "issue-blocked",
      issueNumber: 5,
      title: "Blocked leaf",
      url: "https://github.com/acme/widgets/issues/5",
      blockedBy: [
        {
          issueNumber: 1,
          issueUrl: "https://github.com/acme/widgets/issues/1",
        },
      ],
    }
    const parent = {
      ...issue,
      id: "issue-parent",
      issueNumber: 3,
      title: "Parent",
      url: "https://github.com/acme/widgets/issues/3",
      hasChildren: true,
      blockedBy: [],
    }
    const unfinishedIssue = {
      ...issue,
      id: "issue-unfinished",
      issueNumber: 20,
      title: "Has unfinished Work Item",
      url: "https://github.com/acme/widgets/issues/20",
      blockedBy: [],
    }
    const reconciledAt = new Date("2026-08-12T10:00:00.000Z")
    let requireAgentTurnsCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([
          {
            ...repository,
            issuesReconciledAt: reconciledAt,
          },
        ]),
        listIssues: () =>
          Effect.succeed([actionable, blocked, parent, unfinishedIssue]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([
            {
              ...workItem,
              issueNumber: unfinishedIssue.issueNumber,
            },
          ]),
      },
      {
        requireAgentTurnsAllowed: () =>
          Effect.sync(() => {
            requireAgentTurnsCalls += 1
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query IntakeCandidates($repositoryId: ID!) {
          intakeCandidates(repositoryId: $repositoryId) {
            repository {
              id
              projectPath
              issuesReconciledAt
            }
            candidates {
              issueNumber
              title
              url
              action
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        intakeCandidates: {
          repository: {
            id: repository.id,
            projectPath: repository.projectPath,
            issuesReconciledAt: "2026-08-12T10:00:00.000Z",
          },
          candidates: [
            {
              issueNumber: 12,
              title: "Actionable leaf",
              url: "https://github.com/acme/widgets/issues/12",
              action: "IMPLEMENT_NOW",
            },
            {
              issueNumber: 5,
              title: "Blocked leaf",
              url: "https://github.com/acme/widgets/issues/5",
              action: "QUEUE",
            },
          ],
        },
      },
    })
    expect(requireAgentTurnsCalls).toBe(1)
  })

  test("empty Intake Candidates skip Agent Backend preflight", async () => {
    let requireAgentTurnsCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
      },
      {
        requireAgentTurnsAllowed: () =>
          Effect.sync(() => {
            requireAgentTurnsCalls += 1
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query IntakeCandidates($repositoryId: ID!) {
          intakeCandidates(repositoryId: $repositoryId) {
            repository { id issuesReconciledAt }
            candidates { issueNumber action }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        intakeCandidates: {
          repository: {
            id: repository.id,
            issuesReconciledAt: null,
          },
          candidates: [],
        },
      },
    })
    expect(requireAgentTurnsCalls).toBe(0)
  })

  test("nonempty Intake Candidates surface shared preflight failures", async () => {
    const { AgentBackendUnavailableError } = await import(
      "@ready-for-agent/agent-backend"
    )
    const actionable = {
      ...issue,
      issueNumber: 99,
      blockedBy: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([actionable]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
      },
      {
        requireAgentTurnsAllowed: () =>
          Effect.fail(
            new AgentBackendUnavailableError({
              message: "Agent Backend is unavailable",
              reason: "CLI missing",
            }),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query IntakeCandidates($repositoryId: ID!) {
          intakeCandidates(repositoryId: $repositoryId) {
            candidates { issueNumber }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
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
  })

  test("Intake Candidates reject unknown repository without Refresh", async () => {
    let listIssuesCalls = 0
    await runtime.dispose()
    runtime = makeRuntime({
      listIssues: () =>
        Effect.sync(() => {
          listIssuesCalls += 1
          return []
        }),
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query IntakeCandidates($repositoryId: ID!) {
          intakeCandidates(repositoryId: $repositoryId) {
            candidates { issueNumber }
          }
        }`,
        variables: { repositoryId: "repo-01DOESNOTEXIST00000000000" },
      }),
    )

    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          extensions: expect.objectContaining({
            code: "REPOSITORY_NOT_FOUND",
          }),
        }),
      ],
    })
    expect(listIssuesCalls).toBe(0)
  })

  test("nonempty Intake Candidates reject resolved models missing from catalog", async () => {
    const actionable = {
      ...issue,
      issueNumber: 88,
      blockedBy: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([
          {
            ...repository,
            defaultModel: "stale/model-not-in-catalog",
          },
        ]),
        getBackendModelPrefs: () =>
          Effect.succeed({
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
          }),
        listIssues: () => Effect.succeed([actionable]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query IntakeCandidates($repositoryId: ID!) {
          intakeCandidates(repositoryId: $repositoryId) {
            candidates { issueNumber }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    const body = (await response.json()) as {
      errors: Array<{ message: string; extensions: { code: string } }>
    }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]?.extensions.code).toBe("BUILD_MODEL_NOT_CONFIGURED")
    expect(body.errors[0]?.message).toContain("stale/model-not-in-catalog")
  })

  test("startRepositoryIntake empty candidates succeeds without preflight", async () => {
    let requireAgentTurnsCalls = 0
    let implementCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: () =>
          Effect.sync(() => {
            implementCalls += 1
            return workItem
          }),
        queue: () =>
          Effect.sync(() => {
            implementCalls += 1
            return workItem
          }),
      },
      {
        requireAgentTurnsAllowed: () =>
          Effect.sync(() => {
            requireAgentTurnsCalls += 1
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            repository { id }
            results {
              __typename
              ... on RepositoryIntakeCreated { issueNumber }
              ... on RepositoryIntakeFailed { issueNumber }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        startRepositoryIntake: {
          repository: { id: repository.id },
          results: [],
        },
      },
    })
    expect(requireAgentTurnsCalls).toBe(0)
    expect(implementCalls).toBe(0)
  })

  test("startRepositoryIntake processes candidates sequentially and routes Queue", async () => {
    const actionable = {
      ...issue,
      id: "issue-actionable",
      issueNumber: 12,
      title: "Actionable leaf",
      url: "https://github.com/acme/widgets/issues/12",
      blockedBy: [],
    }
    const blocked = {
      ...issue,
      id: "issue-blocked",
      issueNumber: 5,
      title: "Blocked leaf",
      url: "https://github.com/acme/widgets/issues/5",
      blockedBy: [
        {
          issueNumber: 1,
          issueUrl: "https://github.com/acme/widgets/issues/1",
        },
      ],
    }
    const callOrder: string[] = []
    const createdNow = {
      ...workItem,
      id: "wi-implement-12",
      issueNumber: 12,
      issueTitle: actionable.title,
      waitingForBlockers: false,
      holdsWorkerSlot: true,
    } as WorkItemRecord
    const createdQueue = {
      ...workItem,
      id: "wi-queue-5",
      issueNumber: 5,
      issueTitle: blocked.title,
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      waitingSince: null,
      stepRuns: [],
    } as WorkItemRecord

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([actionable, blocked]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: (repositoryId, issueNumber) =>
          Effect.sync(() => {
            callOrder.push(`implementNow:${repositoryId}:${issueNumber}`)
            return createdNow
          }),
        queue: (repositoryId, issueNumber) =>
          Effect.sync(() => {
            callOrder.push(`queue:${repositoryId}:${issueNumber}`)
            return createdQueue
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            repository { id projectPath }
            results {
              __typename
              ... on RepositoryIntakeCreated {
                issueNumber
                title
                url
                action
                workItem { id state status }
              }
              ... on RepositoryIntakeFailed {
                issueNumber
                error { code message }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    // IMPLEMENT_NOW candidates first (issue 12), then QUEUE (issue 5).
    expect(callOrder).toEqual([
      `implementNow:${repository.id}:12`,
      `queue:${repository.id}:5`,
    ])
    expect(await response.json()).toEqual({
      data: {
        startRepositoryIntake: {
          repository: {
            id: repository.id,
            projectPath: repository.projectPath,
          },
          results: [
            {
              __typename: "RepositoryIntakeCreated",
              issueNumber: 12,
              title: "Actionable leaf",
              url: "https://github.com/acme/widgets/issues/12",
              action: "IMPLEMENT_NOW",
              workItem: {
                id: createdNow.id,
                state: "CREATE_WORKTREE",
                status: "RUNNING",
              },
            },
            {
              __typename: "RepositoryIntakeCreated",
              issueNumber: 5,
              title: "Blocked leaf",
              url: "https://github.com/acme/widgets/issues/5",
              action: "QUEUE",
              workItem: {
                id: createdQueue.id,
                state: "CREATE_WORKTREE",
                status: "WAITING_FOR_BLOCKERS",
              },
            },
          ],
        },
      },
    })
  })

  test("startRepositoryIntake continues after candidate-local failure", async () => {
    const first = {
      ...issue,
      id: "issue-first",
      issueNumber: 10,
      title: "First actionable",
      url: "https://github.com/acme/widgets/issues/10",
      blockedBy: [],
    }
    const second = {
      ...issue,
      id: "issue-second",
      issueNumber: 11,
      title: "Second actionable",
      url: "https://github.com/acme/widgets/issues/11",
      blockedBy: [],
    }
    const createdSecond = {
      ...workItem,
      id: "wi-second",
      issueNumber: 11,
      issueTitle: second.title,
    } as WorkItemRecord
    const callOrder: number[] = []

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([first, second]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: (_repositoryId, issueNumber) =>
          Effect.gen(function* () {
            callOrder.push(issueNumber)
            if (issueNumber === 10) {
              return yield* new UnfinishedWorkItemExistsError({
                repositoryId: repository.id,
                issueNumber,
                workItemId: "wi-existing",
              })
            }
            return createdSecond
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            results {
              __typename
              ... on RepositoryIntakeCreated {
                issueNumber
                workItem { id }
              }
              ... on RepositoryIntakeFailed {
                issueNumber
                error { code message }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(callOrder).toEqual([10, 11])
    expect(await response.json()).toEqual({
      data: {
        startRepositoryIntake: {
          results: [
            {
              __typename: "RepositoryIntakeFailed",
              issueNumber: 10,
              error: {
                code: "UNFINISHED_WORK_ITEM_EXISTS",
                message: `Issue #10 already has an unfinished Work Item`,
              },
            },
            {
              __typename: "RepositoryIntakeCreated",
              issueNumber: 11,
              workItem: { id: createdSecond.id },
            },
          ],
        },
      },
    })
  })

  test("startRepositoryIntake stops on operation-level failure after earlier success", async () => {
    const first = {
      ...issue,
      id: "issue-first",
      issueNumber: 20,
      title: "First",
      url: "https://github.com/acme/widgets/issues/20",
      blockedBy: [],
    }
    const second = {
      ...issue,
      id: "issue-second",
      issueNumber: 21,
      title: "Second",
      url: "https://github.com/acme/widgets/issues/21",
      blockedBy: [],
    }
    const createdFirst = {
      ...workItem,
      id: "wi-first",
      issueNumber: 20,
      issueTitle: first.title,
    } as WorkItemRecord
    const callOrder: number[] = []

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([first, second]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: (_repositoryId, issueNumber) =>
          Effect.gen(function* () {
            callOrder.push(issueNumber)
            if (issueNumber === 20) {
              return createdFirst
            }
            return yield* new EnqueueError({
              queue: "work-item-steps",
              message: "queue infrastructure failed",
            })
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            results {
              __typename
              ... on RepositoryIntakeCreated { issueNumber workItem { id } }
              ... on RepositoryIntakeFailed { issueNumber }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    // Second candidate never completed as result data — operation failed.
    expect(callOrder).toEqual([20, 21])
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "queue infrastructure failed",
          extensions: expect.objectContaining({
            code: "ENQUEUE_ERROR",
          }),
        }),
      ],
    })
  })

  test("startRepositoryIntake runs one preflight before creating Work Items", async () => {
    const actionable = {
      ...issue,
      issueNumber: 30,
      blockedBy: [],
    }
    let requireAgentTurnsCalls = 0
    let implementCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([actionable]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: () =>
          Effect.sync(() => {
            implementCalls += 1
            return workItem
          }),
      },
      {
        requireAgentTurnsAllowed: () =>
          Effect.sync(() => {
            requireAgentTurnsCalls += 1
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            results {
              __typename
              ... on RepositoryIntakeCreated { issueNumber }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(requireAgentTurnsCalls).toBe(1)
    expect(implementCalls).toBe(1)
    expect(await response.json()).toEqual({
      data: {
        startRepositoryIntake: {
          results: [
            {
              __typename: "RepositoryIntakeCreated",
              issueNumber: 30,
            },
          ],
        },
      },
    })
  })

  test("startRepositoryIntake works when Repository is Paused", async () => {
    const actionable = {
      ...issue,
      issueNumber: 31,
      blockedBy: [],
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([
          {
            ...repository,
            paused: true,
          },
        ]),
        listIssues: () => Effect.succeed([actionable]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: () => Effect.succeed(workItem),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            repository { id paused }
            results {
              __typename
              ... on RepositoryIntakeCreated { issueNumber }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        startRepositoryIntake: {
          repository: { id: repository.id, paused: true },
          results: [
            {
              __typename: "RepositoryIntakeCreated",
              issueNumber: 31,
            },
          ],
        },
      },
    })
  })

  test("startRepositoryIntake aborts mid-sequence and preserves earlier Work Items", async () => {
    const first = {
      ...issue,
      id: "issue-abort-1",
      issueNumber: 40,
      title: "First",
      url: "https://github.com/acme/widgets/issues/40",
      blockedBy: [],
    }
    const second = {
      ...issue,
      id: "issue-abort-2",
      issueNumber: 41,
      title: "Second",
      url: "https://github.com/acme/widgets/issues/41",
      blockedBy: [],
    }
    const createdFirst = {
      ...workItem,
      id: "wi-abort-first",
      issueNumber: 40,
    } as WorkItemRecord
    let secondStarted = false
    let secondCompleted = false
    let implementCalls = 0

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listIssues: () => Effect.succeed([first, second]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
        implementNow: (_repositoryId, issueNumber) =>
          Effect.gen(function* () {
            implementCalls += 1
            if (issueNumber === 40) {
              return createdFirst
            }
            secondStarted = true
            yield* Effect.sleep("30 seconds")
            secondCompleted = true
            return workItem
          }),
      },
    )

    const controller = new AbortController()
    const fetchPromise = createGraphqlApi(runtime).fetch(
      graphqlRequest(
        {
          query: `mutation StartIntake($repositoryId: ID!) {
            startRepositoryIntake(repositoryId: $repositoryId) {
              results {
                __typename
                ... on RepositoryIntakeCreated { issueNumber workItem { id } }
              }
            }
          }`,
          variables: { repositoryId: repository.id },
        },
        undefined,
        controller.signal,
      ),
    )

    await waitUntil(() => secondStarted)
    // First Work Item already created before the second candidate blocks.
    expect(implementCalls).toBe(2)
    controller.abort()

    await expect(fetchPromise).rejects.toMatchObject({
      name: "AbortError",
    })
    await Bun.sleep(50)
    expect(secondCompleted).toBe(false)
  })

  test("startRepositoryIntake rejects unknown repository", async () => {
    let listIssuesCalls = 0
    await runtime.dispose()
    runtime = makeRuntime({
      listIssues: () =>
        Effect.sync(() => {
          listIssuesCalls += 1
          return []
        }),
    })

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation StartIntake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            results { __typename }
          }
        }`,
        variables: { repositoryId: "repo-01DOESNOTEXIST00000000000" },
      }),
    )

    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          extensions: expect.objectContaining({
            code: "REPOSITORY_NOT_FOUND",
          }),
        }),
      ],
    })
    expect(listIssuesCalls).toBe(0)
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            status statusLabel statusMessage canRetry isTerminal paused
            lifecycleLabels { phase label status }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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

  test("keeps status and eligibility fields in parity with shared Work Item predicates", async () => {
    const needsHuman = {
      ...workItem,
      id: makeWorkItemId(),
      state: "needs_human",
      paused: true,
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      waitingForBlockers: true,
      stepRuns: [],
    } as WorkItemRecord
    const paused = {
      ...workItem,
      id: makeWorkItemId(),
      state: "implement",
      paused: true,
      stepRuns: [],
    } as WorkItemRecord
    const waitingForBlockers = {
      ...workItem,
      id: makeWorkItemId(),
      waitingForBlockers: true,
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      paused: true,
      stepRuns: [],
    } as WorkItemRecord
    const waitingForWorkerSlot = {
      ...workItem,
      id: makeWorkItemId(),
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      paused: true,
      stepRuns: [],
    } as WorkItemRecord
    const retryable = {
      ...workItem,
      id: makeWorkItemId(),
      state: "implement",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-retryable-parity",
          workItemId: "wi-retryable-parity",
          step: "implement",
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const complete = {
      ...workItem,
      id: makeWorkItemId(),
      state: "complete",
      paused: true,
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      waitingForBlockers: true,
      stepRuns: [],
    } as WorkItemRecord
    const projected = [
      needsHuman,
      paused,
      waitingForBlockers,
      waitingForWorkerSlot,
      retryable,
      complete,
    ]

    expect(
      projected.map(
        (candidate) =>
          evaluateUnfinishedWorkItem({
            ...candidate,
            canRetry: workItemCanRetry(candidate),
          })._tag,
      ),
    ).toEqual([
      "match",
      "match",
      "match",
      "match",
      "match",
      "work_item_finished",
    ])

    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () => Effect.succeed(projected),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id status canRetry isTerminal
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        workItems: [
          {
            id: needsHuman.id,
            status: "NEEDS_HUMAN",
            canRetry: false,
            isTerminal: true,
          },
          {
            id: paused.id,
            status: "NEEDS_HUMAN_REVIEW",
            canRetry: false,
            isTerminal: false,
          },
          {
            id: waitingForBlockers.id,
            status: "WAITING_FOR_BLOCKERS",
            canRetry: false,
            isTerminal: false,
          },
          {
            id: waitingForWorkerSlot.id,
            status: "WAITING_FOR_WORKER_SLOT",
            canRetry: false,
            isTerminal: false,
          },
          {
            id: retryable.id,
            status: "FAILED",
            canRetry: true,
            isTerminal: false,
          },
          {
            id: complete.id,
            status: "COMPLETE",
            canRetry: false,
            isTerminal: true,
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
        query: `query WorkItems($repositoryId: ID!, $issueNumber: Int!) {
          workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            state status statusLabel statusMessage isTerminal
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
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

  test("pauseWorkItem and interruptWorkItem call distinct lifecycle requests", async () => {
    const seen: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        pause: (workItemId) => {
          seen.push(`pause:${workItemId}`)
          return Effect.succeed({ ...workItem, paused: true })
        },
        interrupt: (workItemId) => {
          seen.push(`interrupt:${workItemId}`)
          return Effect.succeed({
            ...workItem,
            paused: false,
            stepRuns: [
              {
                ...workItem.stepRuns[0]!,
                status: "interrupted",
                reasonCode: "paused",
              },
            ],
          })
        },
      },
    )

    const api = createGraphqlApi(runtime)
    const pauseResponse = await api.fetch(
      graphqlRequest({
        query: `mutation PauseWorkItem($workItemId: ID!) {
          pauseWorkItem(workItemId: $workItemId) { id paused hasActiveStepRun }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )
    const interruptResponse = await api.fetch(
      graphqlRequest({
        query: `mutation InterruptWorkItem($workItemId: ID!) {
          interruptWorkItem(workItemId: $workItemId) { id paused canRetry }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(await pauseResponse.json()).toEqual({
      data: {
        pauseWorkItem: {
          id: workItem.id,
          paused: true,
          hasActiveStepRun: true,
        },
      },
    })
    expect(await interruptResponse.json()).toEqual({
      data: {
        interruptWorkItem: {
          id: workItem.id,
          paused: false,
          canRetry: true,
        },
      },
    })
    expect(seen).toEqual([`pause:${workItem.id}`, `interrupt:${workItem.id}`])
  })

  test("retryWorkItems rejects selector validation failures", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryWorkItems($repositoryId: ID!, $selector: RetryWorkItemsSelector!) {
          retryWorkItems(repositoryId: $repositoryId, selector: $selector) {
            results { __typename }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          selector: { issueNumber: 7, allRetryable: true },
        },
      }),
    )

    const body = (await response.json()) as {
      errors: Array<{ message: string; extensions: { code: string } }>
    }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]?.extensions.code).toBe("INVALID_RETRY_SELECTOR")
  })

  test("retryWorkItems empty all-retryable snapshot succeeds without calling retry", async () => {
    let retryCalls = 0
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([
            {
              ...workItem,
              paused: true,
              stepRuns: [
                {
                  ...workItem.stepRuns[0]!,
                  status: "failed",
                  finishedAt: new Date("2026-07-14T08:05:00.000Z"),
                },
              ],
            } as WorkItemRecord,
          ]),
        retry: () =>
          Effect.sync(() => {
            retryCalls += 1
            return workItem
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryAll($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { allRetryable: true }) {
            repository { id }
            results { __typename }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        retryWorkItems: {
          repository: { id: repository.id },
          results: [],
        },
      },
    })
    expect(retryCalls).toBe(0)
  })

  test("retryWorkItems retries failed and interrupted Step Runs and retryable Needs Human", async () => {
    const failed = {
      ...workItem,
      id: "wi-failed",
      issueNumber: 10,
      state: "implement",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const interrupted = {
      ...workItem,
      id: "wi-interrupted",
      issueNumber: 11,
      state: "commit",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          step: "commit",
          status: "interrupted",
          finishedAt: new Date("2026-07-14T08:06:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const needsHuman = {
      ...workItem,
      id: "wi-nh",
      issueNumber: 12,
      state: "needs_human",
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          step: "review",
          status: "succeeded",
          finishedAt: new Date("2026-07-14T08:07:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const callOrder: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([needsHuman, interrupted, failed]),
        retry: (workItemId) =>
          Effect.sync(() => {
            callOrder.push(workItemId)
            const source =
              workItemId === failed.id
                ? failed
                : workItemId === interrupted.id
                  ? interrupted
                  : needsHuman
            return {
              ...source,
              state: source.state === "needs_human" ? "review" : source.state,
              stepRuns: [
                ...source.stepRuns,
                {
                  ...source.stepRuns[0]!,
                  id: `${workItemId}-retry`,
                  status: "queued",
                  finishedAt: null,
                },
              ],
            } as WorkItemRecord
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryAll($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { allRetryable: true }) {
            results {
              __typename
              ... on RetryWorkItemsRetried {
                issueNumber
                workItem { id state status }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(callOrder).toEqual([failed.id, interrupted.id, needsHuman.id])
    expect(await response.json()).toEqual({
      data: {
        retryWorkItems: {
          results: [
            {
              __typename: "RetryWorkItemsRetried",
              issueNumber: 10,
              workItem: {
                id: failed.id,
                state: "IMPLEMENT",
                status: "QUEUED",
              },
            },
            {
              __typename: "RetryWorkItemsRetried",
              issueNumber: 11,
              workItem: {
                id: interrupted.id,
                state: "COMMIT",
                status: "QUEUED",
              },
            },
            {
              __typename: "RetryWorkItemsRetried",
              issueNumber: 12,
              workItem: {
                id: needsHuman.id,
                state: "REVIEW",
                status: "QUEUED",
              },
            },
          ],
        },
      },
    })
  })

  test("retryWorkItems treats Worker Slot exhaustion as a successful Retry", async () => {
    const waiting = {
      ...workItem,
      waitingSince: new Date("2026-07-14T08:05:00.000Z"),
      holdsWorkerSlot: false,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed",
          finishedAt: new Date("2026-07-14T08:04:00.000Z"),
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
        retry: () => Effect.succeed(waiting),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryIssue($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { issueNumber: 42 }) {
            results {
              __typename
              ... on RetryWorkItemsRetried {
                workItem { id status }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        retryWorkItems: {
          results: [
            {
              __typename: "RetryWorkItemsRetried",
              workItem: {
                id: waiting.id,
                status: "WAITING_FOR_WORKER_SLOT",
              },
            },
          ],
        },
      },
    })
  })

  test("retryWorkItems continues after ineligible races and concurrent Retry", async () => {
    const first = {
      ...workItem,
      id: "wi-first",
      issueNumber: 10,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const second = {
      ...first,
      id: "wi-second",
      issueNumber: 11,
    }
    const third = {
      ...first,
      id: "wi-third",
      issueNumber: 12,
    }
    const retried = {
      ...third,
      stepRuns: [
        ...third.stepRuns,
        {
          ...third.stepRuns[0]!,
          id: "srun-retried",
          status: "queued",
          finishedAt: null,
        },
      ],
    } as WorkItemRecord
    const callOrder: string[] = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed([first, second, third]),
        retry: (workItemId) =>
          Effect.gen(function* () {
            callOrder.push(workItemId)
            if (workItemId === first.id) {
              return yield* new RetryNotEligibleError({
                workItemId,
                reason: "paused",
              })
            }
            if (workItemId === second.id) {
              return yield* new ActiveStepRunExistsError({
                workItemId,
                stepRunId: "srun-active",
                status: "running",
              })
            }
            return retried
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryAll($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { allRetryable: true }) {
            results {
              __typename
              ... on RetryWorkItemsRetried {
                issueNumber
                workItem { id }
              }
              ... on RetryWorkItemsSkipped {
                issueNumber
                reason { code }
              }
              ... on RetryWorkItemsFailed {
                issueNumber
                error { code }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(callOrder).toEqual([first.id, second.id, third.id])
    expect(await response.json()).toEqual({
      data: {
        retryWorkItems: {
          results: [
            {
              __typename: "RetryWorkItemsSkipped",
              issueNumber: 10,
              reason: { code: "RETRY_NOT_ELIGIBLE" },
            },
            {
              __typename: "RetryWorkItemsFailed",
              issueNumber: 11,
              error: { code: "ACTIVE_STEP_RUN_EXISTS" },
            },
            {
              __typename: "RetryWorkItemsRetried",
              issueNumber: 12,
              workItem: { id: third.id },
            },
          ],
        },
      },
    })
  })

  test("retryWorkItems all-retryable reports LIMIT_REACHED and DEFERRED without retrying past policy", async () => {
    const limited = {
      ...workItem,
      id: "wi-limited",
      issueNumber: 10,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const deferred = {
      ...limited,
      id: "wi-deferred",
      issueNumber: 11,
    }
    const retryAt = Date.parse("2026-08-15T13:00:00.000Z")
    const seen: Array<{ id: string; autonomous?: number }> = []
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([limited, deferred]),
        retry: (workItemId, options) =>
          Effect.gen(function* () {
            seen.push({
              id: workItemId,
              autonomous: options?.autonomous?.maxRetries,
            })
            if (workItemId === limited.id) {
              return yield* new AutonomousRetryLimitReachedError({
                workItemId,
                used: 3,
                max: 3,
              })
            }
            return yield* new AutonomousRetryDeferredError({
              workItemId,
              retryAt,
            })
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryAll($repositoryId: ID!) {
          retryWorkItems(
            repositoryId: $repositoryId
            selector: { allRetryable: true }
            maxAutonomousRetries: 3
          ) {
            results {
              __typename
              ... on RetryWorkItemsLimitReached {
                issueNumber
                reason { code }
                workItem { canRetry }
              }
              ... on RetryWorkItemsDeferred {
                issueNumber
                retryAt
                reason { code }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(seen).toEqual([
      { id: limited.id, autonomous: 3 },
      { id: deferred.id, autonomous: 3 },
    ])
    expect(await response.json()).toEqual({
      data: {
        retryWorkItems: {
          results: [
            {
              __typename: "RetryWorkItemsLimitReached",
              issueNumber: 10,
              reason: { code: "LIMIT_REACHED" },
              workItem: { canRetry: true },
            },
            {
              __typename: "RetryWorkItemsDeferred",
              issueNumber: 11,
              retryAt: "2026-08-15T13:00:00.000Z",
              reason: { code: "DEFERRED" },
            },
          ],
        },
      },
    })
  })

  test("retryWorkItems verifies a Work Item belongs to the selected Repository", async () => {
    const foreign = {
      ...workItem,
      repositoryId: "repo-other",
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () => Effect.succeed(foreign),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryOne($repositoryId: ID!, $workItemId: ID!) {
          retryWorkItems(
            repositoryId: $repositoryId
            selector: { workItemId: $workItemId }
          ) {
            results { __typename }
          }
        }`,
        variables: {
          repositoryId: repository.id,
          workItemId: foreign.id,
        },
      }),
    )

    const body = (await response.json()) as {
      errors: Array<{ extensions: { code: string } }>
    }
    expect(body.errors[0]?.extensions.code).toBe("WORK_ITEM_NOT_IN_REPOSITORY")
  })

  test("retryWorkItems rejects an Issue with no unfinished Work Item", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForIssue: () =>
          Effect.succeed([
            {
              ...workItem,
              state: "complete",
              stepRuns: [
                {
                  ...workItem.stepRuns[0]!,
                  status: "succeeded",
                  finishedAt: new Date("2026-07-14T08:05:00.000Z"),
                },
              ],
            } as WorkItemRecord,
          ]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryIssue($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { issueNumber: 42 }) {
            results { __typename }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    const body = (await response.json()) as {
      errors: Array<{ extensions: { code: string } }>
    }
    expect(body.errors[0]?.extensions.code).toBe("NO_UNFINISHED_WORK_ITEM")
  })

  test("retryWorkItems stops on operation-level failure after earlier success", async () => {
    const first = {
      ...workItem,
      id: "wi-first",
      issueNumber: 10,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          status: "failed",
          finishedAt: new Date("2026-07-14T08:05:00.000Z"),
        },
      ],
    } as WorkItemRecord
    const second = {
      ...first,
      id: "wi-second",
      issueNumber: 11,
    }
    const retried = {
      ...first,
      stepRuns: [
        ...first.stepRuns,
        {
          ...first.stepRuns[0]!,
          id: "srun-retried",
          status: "queued",
          finishedAt: null,
        },
      ],
    } as WorkItemRecord
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([first, second]),
        retry: (workItemId) =>
          workItemId === first.id
            ? Effect.succeed(retried)
            : Effect.fail(
                new EnqueueError({
                  queue: "work-item-steps",
                  message: "queue infrastructure failed",
                }),
              ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation RetryAll($repositoryId: ID!) {
          retryWorkItems(repositoryId: $repositoryId, selector: { allRetryable: true }) {
            results { __typename }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )

    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "queue infrastructure failed",
          extensions: expect.objectContaining({
            code: "ENQUEUE_ERROR",
          }),
        }),
      ],
    })
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

  test("GitLab repositoryCredentials falls through to ambient when vault never resolves", async () => {
    const gitlabRepository = {
      ...repository,
      forge: "gitlab" as const,
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    }
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([gitlabRepository]),
      },
      {
        findSecrets: () => Effect.never,
      },
      {},
      {},
      {},
      {},
      {},
      {
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
      },
    )

    const started = Date.now()
    const response = await createGraphqlApi(runtime, {
      keymaxxerMetadataTimeout: Duration.millis(50),
    }).fetch(
      graphqlRequest({
        query: `query {
          repositoryCredentials { repositoryId configured }
        }`,
      }),
    )
    const elapsedMs = Date.now() - started

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        repositoryCredentials: [
          { repositoryId: repository.id, configured: true },
        ],
      },
    })
    expect(elapsedMs).toBeLessThan(2_000)
  })

  test("activates GitLab polling via ambient after vault metadata timeout", async () => {
    let ensured = false
    await runtime.dispose()
    runtime = makeRuntime(
      {
        addRepository: (input) =>
          Effect.succeed({ ...repository, ...input, paused: true }),
      },
      {
        findSecret: ({ provider }) =>
          provider === "gitlab" ? Effect.never : Effect.succeed(null),
      },
      {
        ensureKeyed: () => {
          ensured = true
          return Effect.succeed({ jobId: makeJobId(), created: true })
        },
        enqueue: () => Effect.succeed(makeJobId()),
      },
      {},
      {},
      {},
      {},
      {
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
      },
    )

    const started = Date.now()
    const response = await createGraphqlApi(runtime, {
      keymaxxerMetadataTimeout: Duration.millis(50),
    }).fetch(
      graphqlRequest({
        query: `mutation AddRepository($input: AddRepositoryInput!) {
          addRepository(input: $input) { id }
        }`,
        variables: {
          input: {
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/oauth_client",
            localPath: "/tmp/oauth_client",
            isBare: false,
          },
        },
      }),
    )
    const elapsedMs = Date.now() - started

    expect(await response.json()).toEqual({
      data: { addRepository: { id: repository.id } },
    })
    expect(ensured).toBe(true)
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

  test("session reports whether Agent Turn Tail is supported", async () => {
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
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) { agentTurnTailSupported }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { session: { agentTurnTailSupported: true } },
    })
  })

  test("session reports Agent Turn Tail supported for Grok Build", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            agentBackend: "grok",
            sessionId: "ses_owned",
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) { agentTurnTailSupported }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { session: { agentTurnTailSupported: true } },
    })
  })

  test("session reports Agent Turn Tail supported for Codex Build", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.succeed({
            ...workItem,
            agentBackend: "codex",
            sessionId: "019fab2c-9466-7432-ad16-9de23f94f2db",
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Session($workItemId: ID!) {
          session(workItemId: $workItemId) { agentTurnTailSupported }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { session: { agentTurnTailSupported: true } },
    })
  })

  test("agentTurnTail returns null for unknown Work Item", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        getWorkItem: () =>
          Effect.fail(new WorkItemNotFoundError({ workItemId: "wi-missing" })),
      },
      {
        getAgentTurnTail: () => Effect.die("tail must not run"),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Tail($workItemId: ID!) {
          agentTurnTail(workItemId: $workItemId) { availability }
        }`,
        variables: { workItemId: "wi-missing" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { agentTurnTail: null },
    })
  })

  test("agentTurnTail returns the latest turn activity", async () => {
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
        getAgentTurnTail: () =>
          Effect.succeed({
            availability: "available",
            backend: { id: "opencode", label: "OpenCode" },
            jumpHint: false,
            items: [
              {
                kind: "tool",
                name: "bun test",
                status: "failed",
                at: "2026-08-18T12:00:05.000Z",
              },
              {
                kind: "assistant_text",
                text: "tests failed",
                truncated: false,
                at: "2026-08-18T12:00:06.000Z",
              },
            ],
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Tail($workItemId: ID!) {
          agentTurnTail(workItemId: $workItemId) {
            availability
            backend { id label }
            jumpHint
            items {
              ... on AgentTurnTailAssistantText { at text truncated }
              ... on AgentTurnTailTool { at name status }
            }
          }
        }`,
        variables: { workItemId: workItem.id },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        agentTurnTail: {
          availability: "AVAILABLE",
          backend: { id: "opencode", label: "OpenCode" },
          jumpHint: false,
          items: [
            {
              at: "2026-08-18T12:00:05.000Z",
              name: "bun test",
              status: "failed",
            },
            {
              at: "2026-08-18T12:00:06.000Z",
              text: "tests failed",
              truncated: false,
            },
          ],
        },
      },
    })
  })

  test("workItemBySessionId returns backend, Session ID, and worktree for one match", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        findWorkItemBySessionId: (sessionId) =>
          Effect.succeed({
            agentBackend: "grok",
            sessionId,
            worktreePath: "/tmp/worktrees/acme-widgets-7",
          }),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItemBySessionId($sessionId: String!) {
          workItemBySessionId(sessionId: $sessionId) {
            agentBackend { id label }
            sessionId
            worktreePath
          }
        }`,
        variables: { sessionId: "85312e9f-9c57-42ef-9757-b2512cee57cd" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        workItemBySessionId: {
          agentBackend: { id: "grok", label: "Grok Build" },
          sessionId: "85312e9f-9c57-42ef-9757-b2512cee57cd",
          worktreePath: "/tmp/worktrees/acme-widgets-7",
        },
      },
    })
  })

  test("workItemBySessionId fails as not found for zero matches", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        findWorkItemBySessionId: (sessionId) =>
          Effect.fail(new SessionIdNotFoundError({ sessionId })),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItemBySessionId($sessionId: String!) {
          workItemBySessionId(sessionId: $sessionId) {
            sessionId
          }
        }`,
        variables: { sessionId: "missing-session" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "No Work Item owns Session ID: missing-session",
          extensions: {
            code: "SESSION_NOT_FOUND",
            sessionId: "missing-session",
          },
        }),
      ],
    })
  })

  test("workItemBySessionId fails as ambiguous for multiple matches", async () => {
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        findWorkItemBySessionId: (sessionId) =>
          Effect.fail(new SessionIdAmbiguousError({ sessionId })),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query WorkItemBySessionId($sessionId: String!) {
          workItemBySessionId(sessionId: $sessionId) {
            sessionId
          }
        }`,
        variables: { sessionId: "shared-session" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: "Multiple Work Items own Session ID: shared-session",
          extensions: {
            code: "SESSION_AMBIGUOUS",
            sessionId: "shared-session",
          },
        }),
      ],
    })
  })

  test("HTTP abort interrupts the running resolver Effect and runs cleanup", async () => {
    // Issue #974: GraphQL request cancellation must interrupt Effect execution
    // rather than leaving the fiber detached after the client disconnects.
    let started = false
    let completed = false
    let cleanedUp = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.gen(function* () {
            started = true
            yield* Effect.sleep("30 seconds")
            completed = true
            return workItem
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cleanedUp = true
              }),
            ),
          ),
      },
    )

    const controller = new AbortController()
    const fetchPromise = createGraphqlApi(runtime).fetch(
      graphqlRequest(
        {
          query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
            implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
              id
            }
          }`,
          variables: {
            repositoryId: repository.id,
            issueNumber: issue.issueNumber,
          },
        },
        undefined,
        controller.signal,
      ),
    )

    await waitUntil(() => started)
    controller.abort()

    await expect(fetchPromise).rejects.toMatchObject({
      name: "AbortError",
    })
    await waitUntil(() => cleanedUp)
    expect(completed).toBe(false)
    // Detached continuation must not finish after the abort settles.
    await Bun.sleep(50)
    expect(completed).toBe(false)
    expect(cleanedUp).toBe(true)
  })

  test("HTTP abort is not domain result data and later requests keep normal behavior", async () => {
    let implementCalls = 0
    let firstStarted = false
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.gen(function* () {
            implementCalls += 1
            if (implementCalls === 1) {
              firstStarted = true
              yield* Effect.sleep("30 seconds")
            }
            return workItem
          }),
      },
    )

    const api = createGraphqlApi(runtime)
    const controller = new AbortController()
    const aborted = api.fetch(
      graphqlRequest(
        {
          query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
            implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
              id state
            }
          }`,
          variables: {
            repositoryId: repository.id,
            issueNumber: issue.issueNumber,
          },
        },
        undefined,
        controller.signal,
      ),
    )
    await waitUntil(() => firstStarted)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" })

    // Cancelled operation did not return a successful Implement Now payload.
    // A subsequent request without abort retains existing success behavior.
    const response = await api.fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id state
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        implementNow: {
          id: workItem.id,
          state: "CREATE_WORKTREE",
        },
      },
    })
    expect(implementCalls).toBe(2)
  })

  test("domain GraphQL errors still surface when the request is not aborted", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {},
      {},
      {},
      {
        implementNow: () =>
          Effect.fail(
            new IssueNotFoundError({
              repositoryId: repository.id,
              issueNumber: issue.issueNumber,
            }),
          ),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementNow($repositoryId: ID!, $issueNumber: Int!) {
          implementNow(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
          }
        }`,
        variables: {
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          message: `Issue #${issue.issueNumber} was not found in repository ${repository.id}`,
          extensions: { code: "ISSUE_NOT_FOUND" },
        }),
      ],
    })
  })

  test("kanbanStatus returns six empty lanes for all repositories", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([repository]),
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          kanbanStatus {
            repository { id }
            lanes { id label count workItems { workItem { id } } }
          }
        }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        kanbanStatus: {
          repository: null,
          lanes: [
            { id: "QUEUE", label: "Queue", count: 0, workItems: [] },
            { id: "BUILD", label: "Build", count: 0, workItems: [] },
            { id: "REVIEW", label: "Review", count: 0, workItems: [] },
            { id: "PR", label: "PR", count: 0, workItems: [] },
            { id: "ATTENTION", label: "Attention", count: 0, workItems: [] },
            { id: "MERGED", label: "Merged", count: 0, workItems: [] },
          ],
        },
      },
    })
  })

  test("kanbanStatus with zero configured Repositories is a successful empty board", async () => {
    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([]),
        listIssues: () => Effect.succeed([]),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () => Effect.succeed([]),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          kanbanStatus {
            repository { id }
            lanes { id count workItems { workItem { id } } }
          }
        }`,
      }),
    )

    expect(await response.json()).toEqual({
      data: {
        kanbanStatus: {
          repository: null,
          lanes: [
            { id: "QUEUE", count: 0, workItems: [] },
            { id: "BUILD", count: 0, workItems: [] },
            { id: "REVIEW", count: 0, workItems: [] },
            { id: "PR", count: 0, workItems: [] },
            { id: "ATTENTION", count: 0, workItems: [] },
            { id: "MERGED", count: 0, workItems: [] },
          ],
        },
      },
    })
  })

  test("kanbanStatus keeps only the globally newest 15 terminal failures", async () => {
    const now = Date.parse("2026-08-12T12:00:00.000Z")
    const failures = Array.from({ length: 18 }, (_, index) => {
      const issueNumber = 100 + index
      return {
        workItem: {
          ...workItem,
          id: `wi-failed-${index}`,
          repositoryId: repository.id,
          issueNumber,
          state: "failed" as const,
          createdAt: new Date(now - index * 1_000),
          stateReadyAt: new Date(now - index * 1_000),
          stepRuns: [],
        } as WorkItemRecord,
        issue: {
          ...issue,
          id: `issue-failed-${index}`,
          issueNumber,
          title: `Failure ${index}`,
          url: `https://github.com/acme/widgets/issues/${issueNumber}`,
        },
      }
    })

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([repository]),
        listIssues: () => Effect.succeed(failures.map((entry) => entry.issue)),
      },
      {},
      {},
      {
        listWorkItemsForRepository: () =>
          Effect.succeed(failures.map((entry) => entry.workItem)),
      },
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          kanbanStatus {
            lanes {
              id
              count
              workItems { workItem { id } }
            }
          }
        }`,
      }),
    )
    const json = (await response.json()) as {
      data: {
        kanbanStatus: {
          lanes: readonly {
            id: string
            count: number
            workItems: readonly { workItem: { id: string } }[]
          }[]
        }
      }
    }
    const attention = json.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "ATTENTION",
    )
    expect(attention?.count).toBe(15)
    expect(attention?.workItems.map((row) => row.workItem.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `wi-failed-${index}`),
    )
  })

  test("kanbanStatus classifies lanes, windows, ordering, and repository filter", async () => {
    const now = Date.now()
    const otherRepo = makeRepositoryRecord({
      id: "repo-01J00000000000000000000001",
      projectPath: "acme/other",
      localPath: "/repos/acme/other.git",
    })

    const queueItem = {
      ...workItem,
      id: "wi-queue",
      repositoryId: repository.id,
      issueNumber: 10,
      state: "create_worktree" as const,
      waitingForBlockers: true,
      holdsWorkerSlot: false,
      createdAt: new Date(now - 5_000),
      stateReadyAt: new Date(now - 5_000),
      stepRuns: [],
    } as WorkItemRecord
    const buildItem = {
      ...workItem,
      id: "wi-build",
      repositoryId: repository.id,
      issueNumber: 11,
      state: "implement" as const,
      createdAt: new Date(now - 4_000),
      stateReadyAt: new Date(now - 4_000),
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-build",
          workItemId: "wi-build",
          step: "implement" as const,
          status: "running" as const,
        },
      ],
    } as WorkItemRecord
    const attentionWorking = {
      ...workItem,
      id: "wi-attention-working",
      repositoryId: repository.id,
      issueNumber: 12,
      state: "review" as const,
      createdAt: new Date(now - 3_000),
      stateReadyAt: new Date(now - 3_000),
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-attention",
          workItemId: "wi-attention-working",
          step: "review" as const,
          status: "failed" as const,
          finishedAt: new Date(now - 2_900),
        },
      ],
    } as WorkItemRecord
    const terminalFailed = {
      ...workItem,
      id: "wi-failed",
      repositoryId: otherRepo.id,
      issueNumber: 20,
      state: "failed" as const,
      createdAt: new Date(now - 1_000),
      stateReadyAt: new Date(now - 1_000),
      stepRuns: [],
    } as WorkItemRecord
    const merged = {
      ...workItem,
      id: "wi-merged",
      repositoryId: repository.id,
      issueNumber: 13,
      state: "complete" as const,
      createdAt: new Date(now - 20_000),
      stateReadyAt: new Date(now - 2_000),
      stepRuns: [],
    } as WorkItemRecord
    const oldMerged = {
      ...workItem,
      id: "wi-old-merged",
      repositoryId: repository.id,
      issueNumber: 14,
      state: "complete" as const,
      createdAt: new Date(now - 100_000),
      // Far outside the rolling 24h window regardless of wall-clock skew in tests.
      stateReadyAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
      stepRuns: [],
    } as WorkItemRecord
    const queuedStatusCheck = {
      ...workItem,
      id: "wi-pr-queued",
      repositoryId: repository.id,
      issueNumber: 15,
      state: "watch_pr_status_checks" as const,
      createdAt: new Date(now - 500),
      stateReadyAt: new Date(now - 500),
      pullRequestNumber: 99,
      stepRuns: [
        {
          ...workItem.stepRuns[0]!,
          id: "srun-watch",
          workItemId: "wi-pr-queued",
          step: "watch_pr_status_checks" as const,
          status: "queued" as const,
          startedAt: null,
          executionDurationMs: null,
        },
      ],
    } as WorkItemRecord

    const byRepo = new Map<string, WorkItemRecord[]>([
      [
        repository.id,
        [
          queueItem,
          buildItem,
          attentionWorking,
          merged,
          oldMerged,
          queuedStatusCheck,
        ],
      ],
      [otherRepo.id, [terminalFailed]],
    ])

    const otherIssue = {
      ...issue,
      id: "issue-other",
      repositoryId: otherRepo.id,
      issueNumber: terminalFailed.issueNumber,
      title: "Other repo failure",
      url: "https://github.com/acme/other/issues/20",
    }

    await runtime.dispose()
    runtime = makeRuntime(
      {
        listRepositories: Effect.succeed([repository, otherRepo]),
        listIssues: (repositoryId) =>
          Effect.succeed(
            repositoryId === otherRepo.id
              ? [otherIssue]
              : [
                  issue,
                  {
                    ...issue,
                    id: "issue-10",
                    issueNumber: 10,
                  },
                  {
                    ...issue,
                    id: "issue-11",
                    issueNumber: 11,
                  },
                  {
                    ...issue,
                    id: "issue-12",
                    issueNumber: 12,
                  },
                  {
                    ...issue,
                    id: "issue-13",
                    issueNumber: 13,
                  },
                  {
                    ...issue,
                    id: "issue-14",
                    issueNumber: 14,
                  },
                  {
                    ...issue,
                    id: "issue-15",
                    issueNumber: 15,
                  },
                ],
          ),
      },
      {},
      {},
      {
        listWorkItemsForRepository: (repositoryId) =>
          Effect.succeed(byRepo.get(repositoryId) ?? []),
      },
    )

    const allResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          kanbanStatus {
            repository { id }
            lanes {
              id
              count
              workItems {
                repository { id projectPath }
                workItem {
                  id
                  issueNumber
                  state
                  status
                  pullRequestNumber
                }
              }
            }
          }
        }`,
      }),
    )
    const allJson = (await allResponse.json()) as {
      data: {
        kanbanStatus: {
          repository: null
          lanes: readonly {
            id: string
            count: number
            workItems: readonly {
              repository: { id: string; projectPath: string }
              workItem: {
                id: string
                issueNumber: number
                state: string
                status: string
                pullRequestNumber: number | null
              }
            }[]
          }[]
        }
      }
    }
    const lanesById = Object.fromEntries(
      allJson.data.kanbanStatus.lanes.map((lane) => [lane.id, lane]),
    )
    expect(allJson.data.kanbanStatus.repository).toBeNull()
    expect(lanesById.QUEUE?.workItems.map((row) => row.workItem.id)).toEqual([
      "wi-queue",
    ])
    expect(lanesById.BUILD?.workItems.map((row) => row.workItem.id)).toEqual([
      "wi-build",
    ])
    expect(lanesById.PR?.workItems.map((row) => row.workItem.id)).toEqual([
      "wi-pr-queued",
    ])
    expect(lanesById.PR?.workItems[0]?.workItem.pullRequestNumber).toBe(99)
    // Attention newest-first by createdAt: terminal failed (other repo) first.
    expect(
      lanesById.ATTENTION?.workItems.map((row) => row.workItem.id),
    ).toEqual(["wi-failed", "wi-attention-working"])
    expect(lanesById.MERGED?.workItems.map((row) => row.workItem.id)).toEqual([
      "wi-merged",
    ])
    expect(lanesById.REVIEW?.workItems).toEqual([])

    const filteredResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query Kanban($repositoryId: ID) {
          kanbanStatus(repositoryId: $repositoryId) {
            repository { id projectPath }
            lanes {
              id
              workItems {
                repository { id }
                workItem { id }
              }
            }
          }
        }`,
        variables: { repositoryId: repository.id },
      }),
    )
    const filteredJson = (await filteredResponse.json()) as {
      data: {
        kanbanStatus: {
          repository: { id: string; projectPath: string }
          lanes: readonly {
            id: string
            workItems: readonly { workItem: { id: string } }[]
          }[]
        }
      }
    }
    expect(filteredJson.data.kanbanStatus.repository).toEqual({
      id: repository.id,
      projectPath: repository.projectPath,
    })
    const filteredById = Object.fromEntries(
      filteredJson.data.kanbanStatus.lanes.map((lane) => [lane.id, lane]),
    )
    // Global failed cap still includes other-repo failures in the source set,
    // but the repository filter drops them after that set is built.
    expect(
      filteredById.ATTENTION?.workItems.map((row) => row.workItem.id),
    ).toEqual(["wi-attention-working"])
    expect(
      filteredJson.data.kanbanStatus.lanes
        .flatMap((lane) => lane.workItems)
        .every((row) => row.workItem.id !== "wi-failed"),
    ).toBe(true)
  })

  test("kanbanStatus returns REPOSITORY_NOT_FOUND for unknown repositoryId", async () => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `query {
          kanbanStatus(repositoryId: "missing-repo") {
            repository { id }
            lanes { id }
          }
        }`,
      }),
    )
    expect(await response.json()).toEqual({
      data: null,
      errors: [
        expect.objectContaining({
          extensions: { code: "REPOSITORY_NOT_FOUND" },
        }),
      ],
    })
  })
})
