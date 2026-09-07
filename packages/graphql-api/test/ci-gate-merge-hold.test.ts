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
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
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
  models: [{ id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["high"] }],
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

describe("Hold approved merges during CI failure", () => {
  let observe: GitHubServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "main", observations: [] })
  let mergeCalls = 0
  const steps: LifecycleStepsShape = {
    ...successfulSteps,
    mergePr: () =>
      Effect.sync(() => {
        mergeCalls += 1
        return { _tag: "merged" as const }
      }),
  }

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
      Layer.provideMerge(stubActiveAgentBackendLayer()),
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
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
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
    mergeCalls = 0
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const workItemQuery = (repositoryId: string) => ({
    query: `query WorkItems($repositoryId: ID!) {
      workItems(repositoryId: $repositoryId) {
        id
        state
        status
        statusLabel
        statusMessage
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

  test("holds a merge-approved Work Item in the PR lane until CI recovers, then merges", async () => {
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
          issueNumber: 42,
          title: "Implement feature",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/42",
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

    await runtime.runPromise(
      Effect.gen(function* () {
        yield* observeRepositoryCiGate({
          repository: setup.repository,
          origin: "operator",
        })
      }),
    )

    const workItemId = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const created = yield* lifecycle.implementNow(
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
        const afterDecide = yield* claimAndRun
        expect(afterDecide._tag).toBe("processed")
        if (afterDecide._tag === "processed") {
          expect(afterDecide.workItem.state).toBe("merge_pr")
          expect(afterDecide.workItem.waitingForCiRepair).toBe(true)
          expect(afterDecide.workItem.holdsWorkerSlot).toBe(false)
        }
        return created.id
      }),
    )

    const heldResponse = await createGraphqlApi(runtime).fetch(
      graphqlRequest(workItemQuery(setup.repository.id)),
    )
    const heldPayload = (await heldResponse.json()) as {
      data: {
        workItems: ReadonlyArray<{
          id: string
          state: string
          status: string
          statusLabel: string
          statusMessage: string | null
        }>
        kanbanStatus: {
          lanes: ReadonlyArray<{
            id: string
            workItems: ReadonlyArray<{
              workItem: {
                id: string
                status: string
                statusLabel: string
                statusMessage: string | null
              }
            }>
          }>
        }
      }
    }
    const held = heldPayload.data.workItems.find(
      (item) => item.id === workItemId,
    )
    expect(held).toMatchObject({
      state: "MERGE_PR",
      status: "WAITING_FOR_CI_REPAIR",
      statusLabel: "Waiting for CI Repair",
    })
    expect(held?.statusMessage).toContain("Waiting for CI Repair")
    expect(held?.statusMessage).toContain("CI")
    const prLane = heldPayload.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "PR",
    )
    expect(
      prLane?.workItems.some((entry) => entry.workItem.id === workItemId),
    ).toBe(true)
    const queueLane = heldPayload.data.kanbanStatus.lanes.find(
      (lane) => lane.id === "QUEUE",
    )
    expect(
      queueLane?.workItems.some((entry) => entry.workItem.id === workItemId),
    ).toBe(false)
    expect(mergeCalls).toBe(0)

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "161335",
            kind: "observed" as const,
            runs: [
              observedRun({
                runIdentity: "101:1",
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

    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const repositories = yield* db.listRepositories
        const repository = repositories.find(
          (entry) => entry.id === setup.repository.id,
        )
        if (repository === undefined) {
          return yield* Effect.die("missing repository")
        }
        yield* observeRepositoryCiGate({
          repository,
          origin: "polling",
        })
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const sql = yield* SqlClient.SqlClient
        const woken = yield* lifecycle.getWorkItem(workItemId)
        expect(woken.waitingForCiRepair).toBe(false)
        expect(woken.holdsWorkerSlot).toBe(true)
        yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
        const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        expect(Option.isSome(claimed)).toBe(true)
        if (Option.isSome(claimed)) {
          const afterMerge = yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
          expect(afterMerge._tag).toBe("processed")
          if (afterMerge._tag === "processed") {
            expect(afterMerge.workItem.state).toBe("local_cleanup")
          }
        }
      }),
    )
    expect(mergeCalls).toBe(1)
  })
})
