import { Effect, Layer, ManagedRuntime } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  missingSessionTelemetry,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  type CiGateObservation,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
} from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi, observeRepositoryCiGate } from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const unused = () => Effect.die("not used")

const catalog = [
  {
    identity: "161335",
    displayLabel: "CI",
    kind: "workflow",
    diagnosticMetadata: ".github/workflows/ci.yml",
  },
] as const

const observedRun = (input: {
  readonly runIdentity: string
  readonly rawConclusion: string | null
}): CiGateObservation["observations"][number] extends infer Observation
  ? Observation extends { readonly kind: "observed" }
    ? Observation["runs"][number]
    : never
  : never => ({
  runIdentity: input.runIdentity,
  htmlUrl: `https://github.com/acme/widgets/actions/runs/${input.runIdentity.split(":")[0] ?? input.runIdentity}`,
  headSha: `sha-${input.runIdentity}`,
  headRef: "main",
  event: "push",
  createdAt: new Date("2026-09-07T12:00:00.000Z"),
  updatedAt: new Date("2026-09-07T12:05:00.000Z"),
  startedAt: new Date("2026-09-07T12:00:01.000Z"),
  rawStatus: "completed",
  rawConclusion: input.rawConclusion,
})

const readyRuntime = (): AgentBackendRuntimeStatus => ({
  backend: { id: "opencode" as AgentBackendId, label: "OpenCode" },
  kind: "ready",
  reason: null,
  models: [
    { id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["low", "high"] },
  ],
  provider: null,
  warnings: [],
})

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test_implement_session"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () =>
    Effect.succeed({
      _tag: "committed" as const,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 101,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded",
      createdAt: new Date(0),
      headSha: "settled-head",
      headPushedAt: new Date(0),
      isDraft: false,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const graphqlRequest = (body: unknown) =>
  new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("Hold ordinary remote admission during CI failure", () => {
  let observe: GitHubServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "main", observations: [] })

  const githubLayer = Layer.succeed(GitHubService, {
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
        reason: "unused",
      }),
    getPullRequestLifecycleStatus: () => Effect.succeed({ _tag: "open" }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
    rerunWorkflowRun: () => Effect.void,
    uploadUserAttachment: () =>
      Effect.succeed(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      ),
    ensureIssueCompletedWithSummary: () => Effect.void,
    listCiGateCatalog: () => Effect.succeed([...catalog]),
    observeCiGate: (repository, input, options) =>
      observe(repository, input, options),
    listReadyIssues: () => Effect.succeed([]),
  } satisfies GitHubServiceShape)

  const runtimeLayer = Layer.mergeAll(
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        stubActiveAgentBackendLayer({
          models: [
            {
              id: "opencode/deepseek-v4-flash-free",
              thinkingLevels: ["low", "high"],
            },
          ],
        }),
      ),
      Layer.provideMerge(githubLayer),
      Layer.provideMerge(
        Layer.succeed(GitLabService, {
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
          getPullRequestCheckStatus: unused,
          getPrStatusCheckDiagnostics: () => Effect.succeed([]),
          markPullRequestReadyForReview: () => Effect.void,
          getPullRequestLifecycleStatus: () =>
            Effect.succeed({ _tag: "open" as const }),
          mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
          ensureIssueCompletedWithSummary: () => Effect.void,
          closeOpenPullRequestsForBranch: () => Effect.void,
          deleteBranch: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(AzureDevOpsService, {
          verifyProject: (repository) => Effect.succeed(repository),
          getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
          listReadyIssues: () => Effect.succeed([]),
          hasCredentials: () => Effect.succeed(true),
          hasAmbientCredentials: () => Effect.succeed(true),
          getOpenPullRequestNumber: () => Effect.succeed(1),
          findOpenPullRequestNumber: () => Effect.succeed(null),
          createDraftPullRequest: () => Effect.succeed(1),
          ensurePullRequestLinkedToIssue: () => Effect.void,
          updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
          countOpenNonDraftPullRequests: () => Effect.succeed(0),
          getPullRequestCheckStatus: unused,
          getPrStatusCheckDiagnostics: () => Effect.succeed([]),
          markPullRequestReadyForReview: () => Effect.void,
          getPullRequestLifecycleStatus: () =>
            Effect.succeed({ _tag: "open" as const }),
          mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
          ensureIssueCompletedWithSummary: () => Effect.void,
          closeOpenPullRequestsForBranch: () => Effect.void,
          deleteBranch: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    ),
    githubLayer,
    Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed(null),
      findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
      hasSecret: () => Effect.succeed(false),
      addSecret: () => Effect.succeed(true),
      runWithSecrets: () => Effect.die("not used"),
    }),
    Layer.succeed(ActiveAgentBackend, {
      listStatuses: Effect.succeed([readyRuntime()]),
      getBackendStatus: () => Effect.succeed(readyRuntime()),
      getStatus: Effect.succeed(toAgentBackendStatus(readyRuntime())),
      setSelectedOrInUse: () => Effect.succeed([readyRuntime()]),
      recheck: () => Effect.succeed(readyRuntime()),
      requireAgentTurnsAllowed: () => Effect.void,
      activate: () => Effect.succeed(readyRuntime()),
      drop: () => Effect.void,
      preview: () => Effect.succeed(readyRuntime()),
      refreshCatalog: () => Effect.succeed(readyRuntime()),
      withConfigCoordination: (effect) => effect,
      getRegistration: () =>
        Effect.succeed({
          descriptor: { id: "opencode", label: "OpenCode" },
          capabilities: [],
        }),
      getActiveRegistration: Effect.succeed({
        descriptor: { id: "opencode", label: "OpenCode" },
        capabilities: [],
      }),
      startTurn: unused,
      continueTurn: unused,
      inspectBackend: unused,
      getSessionTelemetry: (input) =>
        Effect.succeed(
          missingSessionTelemetry(input.sessionId ?? "", {
            id: "opencode",
            label: "OpenCode",
          }),
        ),
      getAgentTurnTail: () =>
        Effect.succeed({
          availability: "unsupported" as const,
          backend: { id: "opencode", label: "OpenCode" },
          items: [],
          jumpHint: false,
        }),
    }),
    Layer.succeed(LocalGit, {
      inspect: (path) =>
        Effect.succeed({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: path,
          isBare: true,
          paused: true as const,
        }),
    }),
    Layer.succeed(DirectoryPicker, {
      available: Effect.succeed(false),
      pick: Effect.succeed(null),
    }),
  )

  let runtime = ManagedRuntime.make(runtimeLayer)

  afterEach(async () => {
    await runtime.dispose()
    observe = () => Effect.succeed({ defaultBranch: "main", observations: [] })
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const closeGate = (repository: RepositoryRecord) => {
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "161335",
            kind: "observed" as const,
            runs: [
              observedRun({
                runIdentity: "100:1",
                rawConclusion: "failure",
              }),
            ],
          },
        ],
      })
    return runtime.runPromise(
      Effect.gen(function* () {
        yield* observeRepositoryCiGate({
          repository,
          origin: "operator",
        })
      }),
    )
  }

  const seedRepository = (issueNumber: number) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const config = yield* db.getConfig
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: config.reviewModel,
          reviewThinkingLevel: config.reviewThinkingLevel,
          maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
          maxConcurrentWorkItems: config.maxConcurrentWorkItems,
        })
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: `/repos/acme/widgets-${String(Date.now())}.git`,
          isBare: true,
        })
        yield* db.updateRepositorySettings({
          repositoryId: repository.id,
          paused: true,
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          mergePolicy: "classify",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
          selectedCiGateDefinitions: [...catalog],
        })
        const issue = yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber,
          title: "Implement feature",
          body: "Issue body",
          url: `https://github.com/acme/widgets/issues/${issueNumber}`,
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        return { repository, issue }
      }),
    )

  const workItemQuery = (repositoryId: string) => ({
    query: `query WorkItems($repositoryId: ID!) {
      workItems(repositoryId: $repositoryId) {
        id
        state
        status
        statusLabel
        statusMessage
        canRetry
        executionProfile { buildModel }
        mergePolicy
      }
      kanbanStatus(repositoryId: $repositoryId) {
        lanes {
          id
          workItems {
            workItem { id status statusLabel statusMessage }
          }
        }
      }
    }`,
    variables: { repositoryId },
  })

  test("places Implement Now in Queue as Waiting for CI Repair without Failed or Needs Human", async () => {
    const setup = await seedRepository(42)
    await closeGate(setup.repository)

    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return yield* lifecycle.implementNow(
          setup.repository.id,
          setup.issue.issueNumber,
        )
      }),
    )
    expect(created.waitingForCiRepair).toBe(true)
    expect(created.holdsWorkerSlot).toBe(false)
    expect(created.stepRuns).toHaveLength(0)

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const payload = (await response.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          state: string
          status: string
          statusLabel: string
          statusMessage: string | null
          canRetry: boolean
        }>
        kanbanStatus: {
          lanes: ReadonlyArray<{
            id: string
            workItems: ReadonlyArray<{
              workItem: { id: string; status: string }
            }>
          }>
        }
      }
    }
    const held = payload.data.workItems.find((item) => item.id === created.id)
    expect(held).toMatchObject({
      state: "CREATE_WORKTREE",
      status: "WAITING_FOR_CI_REPAIR",
      statusLabel: "Waiting for CI Repair",
      canRetry: false,
    })
    expect(held?.statusMessage).toContain("Waiting for CI Repair")
    expect(held?.statusMessage).toContain("CI")
    expect(held?.status).not.toBe("FAILED")
    expect(held?.status).not.toBe("NEEDS_HUMAN")
    const queueLane = payload.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "QUEUE",
    )
    expect(
      queueLane?.workItems.some((entry) => entry.workItem.id === created.id),
    ).toBe(true)
    const prLane = payload.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "PR",
    )
    expect(
      prLane?.workItems.some((entry) => entry.workItem.id === created.id),
    ).toBe(false)
  })

  test("holds Implement With profile and Merge Policy in Queue", async () => {
    const setup = await seedRepository(43)
    await closeGate(setup.repository)

    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const items = yield* lifecycle.implementWith(
          setup.repository.id,
          setup.issue.issueNumber,
          {
            agentBackendId: "opencode",
            buildModel: "opencode/deepseek-v4-flash-free",
            buildThinkingLevel: "high",
            reviewSameAsBuild: true,
            reviewModel: null,
            reviewThinkingLevel: null,
          },
          { mergePolicy: "always" },
        )
        return items[0]
      }),
    )
    expect(created?.waitingForCiRepair).toBe(true)
    expect(created?.holdsWorkerSlot).toBe(false)
    expect(created?.mergeMode).toBe("always")
    expect(created?.executionProfile?.build.model).toBe(
      "opencode/deepseek-v4-flash-free",
    )

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const payload = (await response.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          status: string
          mergePolicy: string | null
          executionProfile: { buildModel: string } | null
        }>
        kanbanStatus: {
          lanes: ReadonlyArray<{
            id: string
            workItems: ReadonlyArray<{ workItem: { id: string } }>
          }>
        }
      }
    }
    const held = payload.data.workItems.find((item) => item.id === created?.id)
    expect(held?.status).toBe("WAITING_FOR_CI_REPAIR")
    expect(held?.mergePolicy).toBe("ALWAYS")
    expect(held?.executionProfile?.buildModel).toBe(
      "opencode/deepseek-v4-flash-free",
    )
    const queueLane = payload.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "QUEUE",
    )
    expect(
      queueLane?.workItems.some((entry) => entry.workItem.id === created?.id),
    ).toBe(true)
  })

  test("Repository Intake creates ordinary held Work Items", async () => {
    const setup = await seedRepository(44)
    await closeGate(setup.repository)

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Intake($repositoryId: ID!) {
          startRepositoryIntake(repositoryId: $repositoryId) {
            results {
              __typename
              ... on RepositoryIntakeCreated {
                issueNumber
                action
                workItem {
                  id
                  state
                  status
                  statusLabel
                  statusMessage
                }
              }
            }
          }
        }`,
        variables: { repositoryId: setup.repository.id },
      }),
    )
    const payload = (await response.json()) as {
      data: {
        startRepositoryIntake: {
          results: ReadonlyArray<{
            __typename: string
            issueNumber: number
            action: string
            workItem: {
              id: string
              state: string
              status: string
              statusLabel: string
              statusMessage: string | null
            }
          }>
        }
      }
    }
    expect(payload.data.startRepositoryIntake.results).toHaveLength(1)
    const result = payload.data.startRepositoryIntake.results[0]
    expect(result).toMatchObject({
      __typename: "RepositoryIntakeCreated",
      issueNumber: 44,
      action: "IMPLEMENT_NOW",
      workItem: {
        state: "CREATE_WORKTREE",
        status: "WAITING_FOR_CI_REPAIR",
        statusLabel: "Waiting for CI Repair",
      },
    })
    expect(result?.workItem.statusMessage).toContain("Waiting for CI Repair")
    expect(result?.workItem.statusMessage).toContain("CI")
  })
})
