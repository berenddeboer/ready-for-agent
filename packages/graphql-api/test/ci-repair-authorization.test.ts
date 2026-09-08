import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  missingSessionTelemetry,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DatabaseTest, makeFileDatabaseTest } from "@ready-for-agent/db/test"
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
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  RETRYABLE_FAILED_WORK_ITEM_CODE,
  WORK_ITEM_LIFECYCLE_QUEUE,
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

let watchPrStatusCheckTag: "succeeded" | "failed" = "succeeded"

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
      _tag: watchPrStatusCheckTag,
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

const ciRepairFields = `
  ciRepair {
    canAuthorize
    active {
      authorizedAt
      sourceAction
      incident { id status summary }
    }
    history {
      authorizedAt
      sourceAction
      incident { id status summary }
    }
  }
`

type CiRepairProjection = {
  readonly canAuthorize: boolean
  readonly active: {
    readonly authorizedAt: string
    readonly sourceAction: string
    readonly incident: { readonly id: string; readonly status: string }
  } | null
  readonly history: ReadonlyArray<{
    readonly sourceAction: string
    readonly incident: { readonly id: string; readonly status: string }
  }>
}

describe("Authorize incident-scoped CI Repair", () => {
  let observe: GitHubServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "main", observations: [] })
  let mergeCalls = 0
  let checkStatus: "succeeded" | "failed" = "succeeded"

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
        _tag: checkStatus,
        terminalChecks: [],
        mergeability: "mergeable" as const,
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
    mergePullRequest: () => {
      mergeCalls += 1
      return Effect.succeed({ _tag: "merged" as const })
    },
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

  const makeRuntimeLayer = (database = DatabaseTest) =>
    Layer.mergeAll(
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
        Layer.provideMerge(database),
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

  const runtimeLayer = makeRuntimeLayer()
  let runtime = ManagedRuntime.make(runtimeLayer)

  afterEach(async () => {
    await runtime.dispose()
    observe = () => Effect.succeed({ defaultBranch: "main", observations: [] })
    mergeCalls = 0
    checkStatus = "succeeded"
    watchPrStatusCheckTag = "succeeded"
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const closeGate = (
    repository: RepositoryRecord,
    runIdentity = "100:1",
    target: typeof runtime = runtime,
  ) => {
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "161335",
            kind: "observed" as const,
            runs: [
              observedRun({
                runIdentity,
                rawConclusion: "failure",
              }),
            ],
          },
        ],
      })
    return target.runPromise(
      Effect.gen(function* () {
        yield* observeRepositoryCiGate({
          repository,
          origin: "operator",
        })
      }),
    )
  }

  const openGate = (repository: RepositoryRecord, runIdentity = "101:1") => {
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "161335",
            kind: "observed" as const,
            runs: [
              observedRun({
                runIdentity,
                rawConclusion: "success",
              }),
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
          origin: "polling",
        })
      }),
    )
  }

  const degradeGate = (repository: RepositoryRecord) => {
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "161335",
            kind: "unavailable" as const,
            reason: "permission" as const,
            message: "Actions read required",
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

  const seedRepository = (
    issueNumber: number,
    maxWorkItems = 5,
    target: typeof runtime = runtime,
  ) =>
    target.runPromise(
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
          maxConcurrentWorkItems: maxWorkItems,
        })
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: `/repos/acme/widgets-${String(Date.now())}-${issueNumber}.git`,
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

  const addIssue = (
    repositoryId: string,
    issueNumber: number,
    title = "Another feature",
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.storeIssue({
          repositoryId,
          issueNumber,
          title,
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
        executionProfile { buildModel }
        mergePolicy
        ${ciRepairFields}
      }
    }`,
    variables: { repositoryId },
  })

  const implementCiRepairMutation = (
    repositoryId: string,
    issueNumber: number,
  ) => ({
    query: `mutation ImplementCiRepair($repositoryId: ID!, $issueNumber: Int!) {
      implementCiRepair(repositoryId: $repositoryId, issueNumber: $issueNumber) {
        id
        state
        status
        statusLabel
        ${ciRepairFields}
      }
    }`,
    variables: { repositoryId, issueNumber },
  })

  test("Implement CI Repair while Closed creates a Work Item authorized for the active incident", async () => {
    const setup = await seedRepository(42)
    await closeGate(setup.repository)

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const payload = (await response.json()) as {
      data?: {
        implementCiRepair: {
          id: string
          status: string
          ciRepair: CiRepairProjection
        }
      }
      errors?: unknown
    }
    expect(payload.errors).toBeUndefined()
    const created = payload.data?.implementCiRepair
    expect(created?.status).not.toBe("WAITING_FOR_CI_REPAIR")
    expect(created?.ciRepair.active?.sourceAction).toBe("IMPLEMENT_CI_REPAIR")
    expect(created?.ciRepair.active?.incident.status).toBe("OPEN")
    expect(created?.ciRepair.history).toHaveLength(1)
    expect(created?.ciRepair.canAuthorize).toBe(false)

    const record = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return yield* lifecycle.getWorkItem(created?.id ?? "")
      }),
    )
    expect(record.waitingForCiRepair).toBe(false)
    expect(record.holdsWorkerSlot).toBe(true)
    expect(record.stepRuns.length).toBeGreaterThan(0)
  })

  test("CI Repair authorization survives a process restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-repair-authorization-"))
    const filename = join(dir, "harness.sqlite")
    let workItemId = ""
    let repositoryId = ""
    try {
      const firstRuntime = ManagedRuntime.make(
        makeRuntimeLayer(makeFileDatabaseTest(filename)),
      )
      try {
        const setup = await seedRepository(58, 5, firstRuntime)
        await closeGate(setup.repository, "100:1", firstRuntime)
        const response = await createGraphqlApi(firstRuntime).fetch(
          graphqlRequest(
            implementCiRepairMutation(
              setup.repository.id,
              setup.issue.issueNumber,
            ),
          ),
        )
        const payload = (await response.json()) as {
          data?: {
            implementCiRepair: {
              id: string
              status: string
              ciRepair: CiRepairProjection
            }
          }
          errors?: unknown
        }
        expect(payload.errors).toBeUndefined()
        const created = payload.data?.implementCiRepair
        expect(created?.status).not.toBe("WAITING_FOR_CI_REPAIR")
        expect(created?.ciRepair.active?.sourceAction).toBe(
          "IMPLEMENT_CI_REPAIR",
        )
        expect(created?.ciRepair.history).toHaveLength(1)
        workItemId = created?.id ?? ""
        repositoryId = setup.repository.id
      } finally {
        await firstRuntime.dispose()
      }

      const secondRuntime = ManagedRuntime.make(
        makeRuntimeLayer(makeFileDatabaseTest(filename)),
      )
      try {
        const listed = await createGraphqlApi(secondRuntime).fetch(
          graphqlRequest(workItemQuery(repositoryId)),
        )
        const listedPayload = (await listed.json()) as {
          data: {
            workItems: ReadonlyArray<{
              id: string
              status: string
              ciRepair: CiRepairProjection
            }>
          }
        }
        const item = listedPayload.data.workItems.find(
          (candidate) => candidate.id === workItemId,
        )
        expect(item?.status).not.toBe("WAITING_FOR_CI_REPAIR")
        expect(item?.ciRepair.active?.sourceAction).toBe("IMPLEMENT_CI_REPAIR")
        expect(item?.ciRepair.history).toHaveLength(1)
        const record = await secondRuntime.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            return yield* lifecycle.getWorkItem(workItemId)
          }),
        )
        expect(record.waitingForCiRepair).toBe(false)
      } finally {
        await secondRuntime.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("Implement CI Repair is unavailable when the gate is Open", async () => {
    const setup = await seedRepository(43)
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string } }>
    }
    expect(payload.errors?.[0]?.extensions?.code).toBe(
      "CI_REPAIR_NOT_AVAILABLE",
    )
  })

  test("Implement CI Repair is unavailable when the gate is Degraded without an incident", async () => {
    const setup = await seedRepository(44)
    await degradeGate(setup.repository)
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const payload = (await response.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string } }>
    }
    expect(payload.errors?.[0]?.extensions?.code).toBe(
      "CI_REPAIR_NOT_AVAILABLE",
    )
  })

  test("authorizes an existing unfinished Work Item without resetting profile or Merge Policy", async () => {
    const setup = await seedRepository(45)
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
    expect(created?.sessionId).toBeNull()

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) {
            id
            status
            mergePolicy
            executionProfile { buildModel }
            ${ciRepairFields}
          }
        }`,
        variables: { workItemId: created?.id },
      }),
    )
    const payload = (await response.json()) as {
      data?: {
        authorizeWorkItemAsCiRepair: {
          id: string
          status: string
          mergePolicy: string | null
          executionProfile: { buildModel: string } | null
          ciRepair: CiRepairProjection
        }
      }
      errors?: unknown
    }
    expect(payload.errors).toBeUndefined()
    const authorized = payload.data?.authorizeWorkItemAsCiRepair
    expect(authorized?.status).not.toBe("WAITING_FOR_CI_REPAIR")
    expect(authorized?.mergePolicy).toBe("ALWAYS")
    expect(authorized?.executionProfile?.buildModel).toBe(
      "opencode/deepseek-v4-flash-free",
    )
    expect(authorized?.ciRepair.active?.sourceAction).toBe(
      "AUTHORIZE_AS_CI_REPAIR",
    )

    const record = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return yield* lifecycle.getWorkItem(created?.id ?? "")
      }),
    )
    expect(record.waitingForCiRepair).toBe(false)
    expect(record.mergeMode).toBe("always")
    expect(record.executionProfile?.build.thinkingLevel).toBe("high")
    expect(record.pullRequestNumber).toBeNull()
  })

  test("authorization is unavailable for a terminal Work Item and when the gate is Open", async () => {
    const setup = await seedRepository(46)
    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return yield* lifecycle.implementNow(
          setup.repository.id,
          setup.issue.issueNumber,
        )
      }),
    )
    const openResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) { id }
        }`,
        variables: { workItemId: created.id },
      }),
    )
    const openPayload = (await openResponse.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string } }>
    }
    expect(openPayload.errors?.[0]?.extensions?.code).toBe(
      "CI_REPAIR_NOT_AVAILABLE",
    )

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete', holds_worker_slot = 0 WHERE id = ?`,
          [created.id],
        )
      }),
    )
    await closeGate(setup.repository)
    const terminalResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) { id }
        }`,
        variables: { workItemId: created.id },
      }),
    )
    const terminalPayload = (await terminalResponse.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string } }>
    }
    expect(terminalPayload.errors?.[0]?.extensions?.code).toBe(
      "WORK_ITEM_TERMINAL",
    )
  })

  test("authorization remains available for a retryable Failed Work Item", async () => {
    const setup = await seedRepository(56)
    await addIssue(setup.repository.id, 57)
    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const retryable = yield* lifecycle.implementNow(
          setup.repository.id,
          setup.issue.issueNumber,
        )
        const finished = yield* lifecycle.implementNow(setup.repository.id, 57)
        return { retryable, finished }
      }),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'failed',
               failure_code = ?,
               holds_worker_slot = 0
           WHERE id = ?`,
          [RETRYABLE_FAILED_WORK_ITEM_CODE, created.retryable.id],
        )
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'failed',
               failure_code = 'handler_failed',
               holds_worker_slot = 0
           WHERE id = ?`,
          [created.finished.id],
        )
      }),
    )
    await closeGate(setup.repository)

    const listed = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const listedPayload = (await listed.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          ciRepair: CiRepairProjection
        }>
      }
    }
    expect(
      listedPayload.data.workItems.find(
        (item) => item.id === created.retryable.id,
      )?.ciRepair.canAuthorize,
    ).toBe(true)
    expect(
      listedPayload.data.workItems.find(
        (item) => item.id === created.finished.id,
      )?.ciRepair.canAuthorize,
    ).toBe(false)

    const authorized = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) {
            state
            ${ciRepairFields}
          }
        }`,
        variables: { workItemId: created.retryable.id },
      }),
    )
    const authorizedPayload = (await authorized.json()) as {
      data?: {
        authorizeWorkItemAsCiRepair: {
          state: string
          ciRepair: CiRepairProjection
        }
      }
      errors?: unknown
    }
    expect(authorizedPayload.errors).toBeUndefined()
    expect(authorizedPayload.data?.authorizeWorkItemAsCiRepair.state).toBe(
      "FAILED",
    )
    expect(
      authorizedPayload.data?.authorizeWorkItemAsCiRepair.ciRepair.active
        ?.sourceAction,
    ).toBe("AUTHORIZE_AS_CI_REPAIR")

    const refused = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) { id }
        }`,
        variables: { workItemId: created.finished.id },
      }),
    )
    const refusedPayload = (await refused.json()) as {
      errors?: ReadonlyArray<{ extensions?: { code?: string } }>
    }
    expect(refusedPayload.errors?.[0]?.extensions?.code).toBe(
      "WORK_ITEM_TERMINAL",
    )
  })

  test("a CI Repair waits for an ordinary Worker Slot when capacity is full", async () => {
    const setup = await seedRepository(47, 1)
    await addIssue(setup.repository.id, 48)
    await closeGate(setup.repository)

    const first = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const firstPayload = (await first.json()) as {
      data?: { implementCiRepair: { id: string; status: string } }
    }
    expect(firstPayload.data?.implementCiRepair.status).not.toBe(
      "WAITING_FOR_CI_REPAIR",
    )

    const second = await createGraphqlApi(runtime).fetch(
      graphqlRequest(implementCiRepairMutation(setup.repository.id, 48)),
    )
    const secondPayload = (await second.json()) as {
      data?: {
        implementCiRepair: {
          id: string
          status: string
          ciRepair: CiRepairProjection
        }
      }
    }
    expect(secondPayload.data?.implementCiRepair.status).toBe(
      "WAITING_FOR_WORKER_SLOT",
    )
    expect(secondPayload.data?.implementCiRepair.ciRepair.active).not.toBeNull()

    const record = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return yield* lifecycle.getWorkItem(
          secondPayload.data?.implementCiRepair.id ?? "",
        )
      }),
    )
    expect(record.waitingForCiRepair).toBe(false)
    expect(record.holdsWorkerSlot).toBe(false)
    expect(record.waitingSince).not.toBeNull()
    expect(record.stepRuns).toHaveLength(0)
  })

  test("multiple CI Repairs may be authorized for one incident", async () => {
    const setup = await seedRepository(49, 2)
    await addIssue(setup.repository.id, 50)
    await closeGate(setup.repository)

    const first = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const second = await createGraphqlApi(runtime).fetch(
      graphqlRequest(implementCiRepairMutation(setup.repository.id, 50)),
    )
    const firstPayload = (await first.json()) as {
      data?: { implementCiRepair: { id: string; ciRepair: CiRepairProjection } }
    }
    const secondPayload = (await second.json()) as {
      data?: { implementCiRepair: { id: string; ciRepair: CiRepairProjection } }
    }
    expect(
      firstPayload.data?.implementCiRepair.ciRepair.active?.incident.id,
    ).toBe(secondPayload.data?.implementCiRepair.ciRepair.active?.incident.id)
    const records = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        return [
          yield* lifecycle.getWorkItem(
            firstPayload.data?.implementCiRepair.id ?? "",
          ),
          yield* lifecycle.getWorkItem(
            secondPayload.data?.implementCiRepair.id ?? "",
          ),
        ]
      }),
    )
    expect(records.every((item) => item.holdsWorkerSlot)).toBe(true)
    expect(records.every((item) => !item.waitingForCiRepair)).toBe(true)
  })

  test("resolving the incident expires authorization; a later incident requires a new authorization", async () => {
    const setup = await seedRepository(51)
    await addIssue(setup.repository.id, 52)
    await closeGate(setup.repository)

    const repairResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest(
        implementCiRepairMutation(setup.repository.id, setup.issue.issueNumber),
      ),
    )
    const repairPayload = (await repairResponse.json()) as {
      data?: {
        implementCiRepair: { id: string; ciRepair: CiRepairProjection }
      }
    }
    const firstIncidentId =
      repairPayload.data?.implementCiRepair.ciRepair.active?.incident.id
    expect(firstIncidentId).toBeDefined()

    await openGate(setup.repository)
    const afterOpen = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const afterOpenPayload = (await afterOpen.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          ciRepair: CiRepairProjection
        }>
      }
    }
    const afterOpenItem = afterOpenPayload.data.workItems.find(
      (item) => item.id === repairPayload.data?.implementCiRepair.id,
    )
    expect(afterOpenItem?.ciRepair.active).toBeNull()
    expect(afterOpenItem?.ciRepair.history).toHaveLength(1)
    expect(afterOpenItem?.ciRepair.history[0]?.incident.id).toBe(
      firstIncidentId,
    )

    await closeGate(setup.repository, "300:1")
    const laterQuery = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const laterPayload = (await laterQuery.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          status: string
          ciRepair: CiRepairProjection
        }>
      }
    }
    const laterItem = laterPayload.data.workItems.find(
      (item) => item.id === repairPayload.data?.implementCiRepair.id,
    )
    expect(laterItem?.ciRepair.active).toBeNull()
    expect(laterItem?.ciRepair.canAuthorize).toBe(true)

    const reauthorize = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) {
            ${ciRepairFields}
          }
        }`,
        variables: { workItemId: repairPayload.data?.implementCiRepair.id },
      }),
    )
    const reauthorizePayload = (await reauthorize.json()) as {
      data?: { authorizeWorkItemAsCiRepair: { ciRepair: CiRepairProjection } }
    }
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.ciRepair.active
        ?.sourceAction,
    ).toBe("AUTHORIZE_AS_CI_REPAIR")
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.ciRepair.history,
    ).toHaveLength(2)
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.ciRepair.active
        ?.incident.id,
    ).not.toBe(firstIncidentId)
  })

  test("parent Implement All never bulk-authorizes CI Repair", async () => {
    const setup = await runtime.runPromise(
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
          projectPath: "acme/widgets-parent",
          localPath: `/repos/acme/widgets-parent-${String(Date.now())}.git`,
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
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 100,
          title: "Parent feature",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/100",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: true,
          blockedBy: [],
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 101,
          title: "Child feature",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/101",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: {
            issueNumber: 100,
            issueUrl: "https://github.com/acme/widgets/issues/100",
          },
          parentPosition: 0,
          hasChildren: false,
          blockedBy: [],
        })
        return repository
      }),
    )
    await closeGate(setup)

    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation ImplementAll($repositoryId: ID!, $issueNumber: Int!) {
          implementAllWithAutoMerge(repositoryId: $repositoryId, issueNumber: $issueNumber) {
            id
            status
            ${ciRepairFields}
          }
        }`,
        variables: { repositoryId: setup.id, issueNumber: 100 },
      }),
    )
    const payload = (await response.json()) as {
      data?: {
        implementAllWithAutoMerge: ReadonlyArray<{
          status: string
          ciRepair: CiRepairProjection
        }>
      }
    }
    expect(payload.data?.implementAllWithAutoMerge).toHaveLength(1)
    expect(payload.data?.implementAllWithAutoMerge[0]?.status).toBe(
      "WAITING_FOR_CI_REPAIR",
    )
    expect(
      payload.data?.implementAllWithAutoMerge[0]?.ciRepair.active,
    ).toBeNull()
    expect(
      payload.data?.implementAllWithAutoMerge[0]?.ciRepair.history,
    ).toEqual([])
  })

  test("CI Repair still obeys failed PR Status Checks and does not merge", async () => {
    checkStatus = "failed"
    watchPrStatusCheckTag = "failed"
    const setup = await seedRepository(53)
    await closeGate(setup.repository)
    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const workItem = yield* lifecycle.implementCiRepair(
          setup.repository.id,
          setup.issue.issueNumber,
        )
        const claimAndRun = Effect.gen(function* () {
          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected a queued lifecycle job")
          }
          return yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
        })
        let watched = false
        for (let index = 0; index < 20; index += 1) {
          const result = yield* claimAndRun
          if (result._tag !== "processed") {
            continue
          }
          if (
            result.workItem.state === "merge_pr" ||
            result.workItem.state === "local_cleanup" ||
            result.workItem.state === "complete"
          ) {
            return result.workItem
          }
          if (
            result.workItem.state === "failed" ||
            result.workItem.state === "investigate_pr_status_checks" ||
            result.workItem.state === "needs_human"
          ) {
            return result.workItem
          }
          if (result.workItem.state === "watch_pr_status_checks") {
            if (watched) {
              return result.workItem
            }
            watched = true
          }
        }
        return yield* lifecycle.getWorkItem(workItem.id)
      }),
    )
    expect(created.state).not.toBe("merge_pr")
    expect(created.state).not.toBe("local_cleanup")
    expect(created.state).not.toBe("complete")
    expect(mergeCalls).toBe(0)
  })

  test("an authorized CI Repair crosses the pre-merge hold for its incident", async () => {
    const setup = await seedRepository(54)
    await closeGate(setup.repository)
    const afterMerge = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const created = yield* lifecycle.implementCiRepair(
          setup.repository.id,
          setup.issue.issueNumber,
        )
        expect(created.waitingForCiRepair).toBe(false)
        const claimAndRun = Effect.gen(function* () {
          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected a queued lifecycle job")
          }
          return yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
        })
        for (let index = 0; index < 8; index += 1) {
          yield* claimAndRun
        }
        yield* sql.unsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        yield* claimAndRun
        const atMerge = yield* claimAndRun
        expect(atMerge._tag).toBe("processed")
        if (atMerge._tag === "processed") {
          expect(atMerge.workItem.waitingForCiRepair).toBe(false)
          expect(atMerge.workItem.state).toBe("merge_pr")
        }
        return yield* claimAndRun
      }),
    )
    expect(afterMerge._tag).toBe("processed")
    if (afterMerge._tag === "processed") {
      expect(afterMerge.workItem.waitingForCiRepair).toBe(false)
      expect(afterMerge.workItem.state).toBe("local_cleanup")
    }
  })

  test("a later incident refuses the previous authorization at merge until reauthorized", async () => {
    const setup = await seedRepository(55)
    await closeGate(setup.repository)
    const workItemId = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const created = yield* lifecycle.implementCiRepair(
          setup.repository.id,
          setup.issue.issueNumber,
        )
        const claimAndRun = Effect.gen(function* () {
          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected a queued lifecycle job")
          }
          return yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
        })
        for (let index = 0; index < 8; index += 1) {
          yield* claimAndRun
        }
        yield* sql.unsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        yield* claimAndRun
        const atMerge = yield* claimAndRun
        expect(atMerge._tag).toBe("processed")
        if (atMerge._tag === "processed") {
          expect(atMerge.workItem.state).toBe("merge_pr")
          expect(atMerge.workItem.waitingForCiRepair).toBe(false)
        }
        return created.id
      }),
    )

    await openGate(setup.repository)
    await closeGate(setup.repository, "300:1")

    const held = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
        const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(claimed)) {
          return yield* lifecycle.getWorkItem(workItemId)
        }
        const result = yield* lifecycle.runStep(
          (claimed.value.payload as { stepRunId: string }).stepRunId,
        )
        if (result._tag === "processed") {
          return result.workItem
        }
        return yield* lifecycle.getWorkItem(workItemId)
      }),
    )
    expect(held.waitingForCiRepair).toBe(true)
    expect(held.state).toBe("merge_pr")

    const projected = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const projectedPayload = (await projected.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          status: string
          ciRepair: CiRepairProjection
        }>
      }
    }
    const item = projectedPayload.data.workItems.find(
      (candidate) => candidate.id === workItemId,
    )
    expect(item?.ciRepair.active).toBeNull()
    expect(item?.ciRepair.canAuthorize).toBe(true)
    expect(item?.status).toBe("WAITING_FOR_CI_REPAIR")

    const reauthorize = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation Authorize($workItemId: ID!) {
          authorizeWorkItemAsCiRepair(workItemId: $workItemId) {
            status
            ${ciRepairFields}
          }
        }`,
        variables: { workItemId },
      }),
    )
    const reauthorizePayload = (await reauthorize.json()) as {
      data?: {
        authorizeWorkItemAsCiRepair: {
          status: string
          ciRepair: CiRepairProjection
        }
      }
    }
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.status,
    ).not.toBe("WAITING_FOR_CI_REPAIR")
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.ciRepair.active
        ?.sourceAction,
    ).toBe("AUTHORIZE_AS_CI_REPAIR")
    expect(
      reauthorizePayload.data?.authorizeWorkItemAsCiRepair.ciRepair.history,
    ).toHaveLength(2)

    const afterReauth = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
        const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(claimed)) {
          return yield* lifecycle.getWorkItem(workItemId)
        }
        const result = yield* lifecycle.runStep(
          (claimed.value.payload as { stepRunId: string }).stepRunId,
        )
        if (result._tag === "processed") {
          return result.workItem
        }
        return yield* lifecycle.getWorkItem(workItemId)
      }),
    )
    expect(afterReauth.waitingForCiRepair).toBe(false)
    expect(afterReauth.state).toBe("local_cleanup")
  })
})
