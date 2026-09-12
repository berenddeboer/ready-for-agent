import { Duration, Effect, Layer, ManagedRuntime } from "effect"
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
import type {
  CiGateCatalogEntry,
  CiGateObservation,
} from "@ready-for-agent/forge-contract"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import { QueueService, makeJobId } from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import { WorkItemLifecycle } from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi, observeRepositoryCiGate } from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const unused = () => Effect.die("not used")

const catalog: CiGateCatalogEntry[] = [
  {
    identity: "42",
    displayLabel: "Project pipeline",
    kind: "project-pipeline",
    diagnosticMetadata: ".gitlab-ci.yml",
  },
]

const observedRun = (input: {
  readonly runIdentity: string
  readonly rawStatus: string
  readonly event?: string
  readonly createdAt?: string
}): CiGateObservation["observations"][number] extends infer Observation
  ? Observation extends { readonly kind: "observed" }
    ? Observation["runs"][number]
    : never
  : never => ({
  runIdentity: input.runIdentity,
  htmlUrl: `https://git.drupalcode.org/project/oauth_client/-/pipelines/${input.runIdentity.split(":")[0] ?? input.runIdentity}`,
  headSha: `sha-${input.runIdentity}`,
  headRef: "main",
  event: input.event ?? "push",
  createdAt: new Date(input.createdAt ?? "2026-09-07T12:00:00.000Z"),
  updatedAt: new Date("2026-09-07T12:05:00.000Z"),
  startedAt: new Date("2026-09-07T12:00:01.000Z"),
  rawStatus: input.rawStatus,
  rawConclusion: null,
})

const observedDefinition = (
  identity: string,
  runs: ReturnType<typeof observedRun>[],
): CiGateObservation["observations"][number] => ({
  identity,
  kind: "observed",
  runs,
})

const readyRuntime = (): AgentBackendRuntimeStatus => ({
  backend: { id: "opencode" as AgentBackendId, label: "OpenCode" },
  kind: "ready",
  reason: null,
  models: [{ id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["high"] }],
  provider: null,
  warnings: [],
})

const settingsInput = (
  repositoryId: string,
  identities: readonly string[],
) => ({
  repositoryId,
  paused: true,
  defaultModel: null,
  defaultThinkingLevel: null,
  reviewModel: null,
  reviewThinkingLevel: null,
  mergePolicy: "OFF",
  includeAllIssueAuthors: false,
  waitForReadyForReviewChecks: true,
  selectedCiGateDefinitionIdentities: [...identities],
})

const ciGateQuery = {
  query: `query {
    repositories {
      id
      ciGate {
        enabled
        status
        observedAt
        defaultBranch
        diagnostic
        definitions {
          identity
          displayLabel
          failureLatched
          diagnostic
          latestRun {
            runIdentity
            htmlUrl
            rawStatus
            rawConclusion
            event
            headSha
            headRef
          }
        }
        activeIncident {
          status
          summary
          failedDefinitions { identity displayLabel }
        }
        latestResolvedIncident {
          status
          summary
          recoveryReason
          failedDefinitions { identity displayLabel }
        }
      }
    }
  }`,
}

const graphqlRequest = (body: unknown) =>
  new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("GitLab Repository CI Gate", () => {
  let observe: GitLabServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "main", observations: [] })
  let pullRequestCheckStatusCalls = 0
  let githubObserveCalls = 0

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
    mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
    rerunWorkflowRun: () => Effect.void,
    uploadUserAttachment: () =>
      Effect.succeed(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      ),
    ensureIssueCompletedWithSummary: () => Effect.void,
    listCiGateCatalog: () => Effect.succeed([]),
    observeCiGate: () => {
      githubObserveCalls += 1
      return Effect.die("GitHub CI Gate must not observe a GitLab Repository")
    },
    listReadyIssues: () => Effect.succeed([]),
  } satisfies GitHubServiceShape)

  const runtimeLayer = Layer.mergeAll(
    DbServiceLive.pipe(Layer.provideMerge(DatabaseTest)),
    githubLayer,
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
      listCiGateCatalog: () => Effect.succeed([...catalog]),
      observeCiGate: (repository, input) => observe(repository, input),
      getPullRequestCheckStatus: () => {
        pullRequestCheckStatusCalls += 1
        return Effect.succeed({
          _tag: "succeeded" as const,
          terminalChecks: [
            {
              externalId: "gitlab-job:1",
              name: "test",
              outcome: "green" as const,
            },
          ],
          mergeability: "mergeable" as const,
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        })
      },
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      markPullRequestReadyForReview: () => Effect.void,
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: () => Effect.void,
      closeOpenPullRequestsForBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
    }),
    Layer.succeed(AzureDevOpsService, {
      verifyProject: (repository) => Effect.succeed(repository),
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      listCiGateCatalog: () => Effect.succeed([]),
      observeCiGate: () =>
        Effect.succeed({
          defaultBranch: "refs/heads/main",
          observations: [],
        }),
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
    Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed(null),
      findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
      hasSecret: () => Effect.succeed(false),
      addSecret: () => Effect.succeed(true),
      runWithSecrets: () => Effect.die("not used"),
    }),
    Layer.succeed(
      QueueService,
      stubQueueService({
        enqueue: () => Effect.succeed(makeJobId()),
      }),
    ),
    Layer.succeed(WorkItemLifecycle, {
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
      implementCiRepair: unused,
      authorizeAsCiRepair: unused,
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
      listWorkItemsForRepository: () => Effect.succeed([]),
      listCompletedWorkItems: unused,
      ownsSessionId: () => Effect.succeed(false),
      findWorkItemBySessionId: unused,
      countCommittedPullRequests: unused,
      continueAfterHumanPrOutcome: unused,
      stopForCompetingIssueClosingPullRequests: () => Effect.succeed(0),
      admitWaitingWorkItems: Effect.succeed(0),
      releaseWaitingForBlockers: () => Effect.succeed(0),
      releaseWaitingForCiRepair: () => Effect.succeed(0),
      completeParkedAttentionWhenIssueNoLongerRelevant: () => Effect.succeed(0),
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
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
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
    pullRequestCheckStatusCalls = 0
    githubObserveCalls = 0
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const addRepository = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.addRepository({
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
          localPath: `/repos/project/oauth_client-${String(Date.now())}.git`,
          isBare: true,
        })
      }),
    )

  const fetchCiGate = async (repositoryId: string) => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(ciGateQuery),
    )
    const payload = (await response.json()) as {
      data: {
        repositories: ReadonlyArray<{
          id: string
          ciGate: {
            enabled: boolean
            status: string
            diagnostic: string | null
            defaultBranch: string | null
            definitions: ReadonlyArray<{
              identity: string
              displayLabel: string
              failureLatched: boolean
              latestRun: {
                runIdentity: string
                htmlUrl: string | null
                rawStatus: string | null
                rawConclusion: string | null
                event: string | null
              } | null
            }>
            activeIncident: {
              status: string
              failedDefinitions: ReadonlyArray<{
                identity: string
                displayLabel: string
              }>
            } | null
            latestResolvedIncident: {
              status: string
              recoveryReason: string | null
            } | null
          }
        }>
      }
    }
    const repository = payload.data.repositories.find(
      (entry) => entry.id === repositoryId,
    )
    if (repository === undefined) {
      throw new Error(`Missing repository ${repositoryId}`)
    }
    return repository.ciGate
  }

  const saveSelection = async (
    repositoryId: string,
    identities: readonly string[],
  ) => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest({
        query: `mutation UpdateRepositorySettings($input: UpdateRepositorySettingsInput!) {
          updateRepositorySettings(input: $input) {
            id
            selectedCiGateDefinitions { identity displayLabel kind diagnosticMetadata }
            ciGate { status enabled }
          }
        }`,
        variables: { input: settingsInput(repositoryId, identities) },
      }),
    )
    return response.json() as Promise<{
      data: {
        updateRepositorySettings: {
          id: string
          selectedCiGateDefinitions: ReadonlyArray<{
            identity: string
            displayLabel: string
            kind: string
            diagnosticMetadata: string | null
          }>
          ciGate: { status: string; enabled: boolean }
        }
      }
      errors?: unknown
    }>
  }

  const refresh = (repositoryId: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const repositories = yield* db.listRepositories
        const repository = repositories.find(
          (entry) => entry.id === repositoryId,
        )
        if (repository === undefined) {
          throw new Error(`Missing repository ${repositoryId}`)
        }
        yield* observeRepositoryCiGate({
          repository,
          origin: "polling",
        })
      }),
    )

  test("selects the synthesized Project pipeline, latches Closed on failed, and recovers on newer success", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({ runIdentity: "47:12", rawStatus: "success" }),
          ]),
        ],
      })

    const saved = await saveSelection(repository.id, ["42"])
    expect(saved.errors).toBeUndefined()
    expect(
      saved.data.updateRepositorySettings.selectedCiGateDefinitions,
    ).toEqual([
      {
        identity: "42",
        displayLabel: "Project pipeline",
        kind: "project-pipeline",
        diagnosticMetadata: ".gitlab-ci.yml",
      },
    ])
    expect(saved.data.updateRepositorySettings.ciGate).toEqual({
      status: "OPEN",
      enabled: true,
    })

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({
              runIdentity: "48:13",
              rawStatus: "failed",
              event: "push",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.definitions[0]?.failureLatched).toBe(true)
    expect(gate.definitions[0]?.latestRun?.rawStatus).toBe("failed")
    expect(gate.definitions[0]?.latestRun?.htmlUrl).toContain("/-/pipelines/48")
    expect(gate.activeIncident?.status).toBe("OPEN")
    expect(gate.activeIncident?.failedDefinitions).toEqual([
      { identity: "42", displayLabel: "Project pipeline" },
    ])

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({ runIdentity: "49:14", rawStatus: "running" }),
            observedRun({ runIdentity: "48:13", rawStatus: "failed" }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({
              runIdentity: "50:15",
              rawStatus: "success",
              event: "web",
            }),
            observedRun({ runIdentity: "48:13", rawStatus: "failed" }),
          ]),
        ],
      })
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.status).toBe("RESOLVED")
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("NEWER_SUCCESS")
    expect(githubObserveCalls).toBe(0)
    expect(pullRequestCheckStatusCalls).toBe(0)
  })

  test("canceled, skipped, manual, scheduled, pending, running, preparing, and waiting do not close an Open gate", async () => {
    const repository = await addRepository()
    const statuses = [
      "canceled",
      "skipped",
      "manual",
      "scheduled",
      "pending",
      "running",
      "preparing",
      "waiting_for_resource",
    ]
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition(
            "42",
            statuses.map((status, index) =>
              observedRun({
                runIdentity: `${String(100 + index)}:${String(index + 1)}`,
                rawStatus: status,
              }),
            ),
          ),
        ],
      })
    await saveSelection(repository.id, ["42"])
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.definitions[0]?.failureLatched).toBe(false)
    expect(gate.activeIncident).toBeNull()
  })

  test("a pipeline-read permission failure degrades Open and cannot clear a Closed latch", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({ runIdentity: "47:12", rawStatus: "success" }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["42"])
    observe = () =>
      Effect.fail(
        new GitLabRequestError({
          message:
            "Failed to observe CI Gate Definitions for project/oauth_client: API/pipeline read required",
          statusCode: 403,
        }),
      )
    await refresh(repository.id)
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DEGRADED")
    expect(gate.diagnostic).toContain("API/pipeline read required")
    expect(gate.activeIncident).toBeNull()

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({ runIdentity: "48:13", rawStatus: "failed" }),
          ]),
        ],
      })
    await refresh(repository.id)
    observe = () =>
      Effect.fail(
        new GitLabRequestError({
          message:
            "Failed to observe CI Gate Definitions for project/oauth_client: API/pipeline read required",
          statusCode: 403,
        }),
      )
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.activeIncident?.status).toBe("OPEN")
  })

  test("a saved Project pipeline stays selected and Degraded when project CI becomes disabled", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("42", [
            observedRun({ runIdentity: "47:12", rawStatus: "success" }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["42"])
    expect((await fetchCiGate(repository.id)).status).toBe("OPEN")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          {
            identity: "42",
            kind: "unavailable",
            reason: "not_found",
            message: "Project CI is disabled for project/oauth_client",
          },
        ],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DEGRADED")
    expect(gate.definitions).toEqual([
      expect.objectContaining({
        identity: "42",
        displayLabel: "Project pipeline",
        failureLatched: false,
      }),
    ])
    expect(gate.activeIncident).toBeNull()
  })
})
