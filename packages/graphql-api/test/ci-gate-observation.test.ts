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
import {
  type CiGateObservation,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import { QueueService, makeJobId } from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import { WorkItemLifecycle } from "@ready-for-agent/work-item-lifecycle"
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
  {
    identity: "269289",
    displayLabel: "Nightly",
    kind: "workflow",
    diagnosticMetadata: ".github/workflows/nightly.yml",
  },
] as const

const observedRun = (input: {
  readonly runIdentity: string
  readonly rawStatus: string
  readonly rawConclusion: string | null
  readonly event?: string
  readonly createdAt?: string
}): CiGateObservation["observations"][number] extends infer Observation
  ? Observation extends { readonly kind: "observed" }
    ? Observation["runs"][number]
    : never
  : never => ({
  runIdentity: input.runIdentity,
  htmlUrl: `https://github.com/acme/widgets/actions/runs/${input.runIdentity.split(":")[0] ?? input.runIdentity}`,
  headSha: `sha-${input.runIdentity}`,
  headRef: "main",
  event: input.event ?? "push",
  createdAt: new Date(input.createdAt ?? "2026-09-07T12:00:00.000Z"),
  updatedAt: new Date("2026-09-07T12:05:00.000Z"),
  startedAt: new Date("2026-09-07T12:00:01.000Z"),
  rawStatus: input.rawStatus,
  rawConclusion: input.rawConclusion,
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

const ciGateQuery = (repositoryId: string) => ({
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
  variables: { repositoryId },
})

const graphqlRequest = (body: unknown) =>
  new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("Repository CI Gate observation", () => {
  let observe: GitHubServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "main", observations: [] })
  let listReadyIssues: GitHubServiceShape["listReadyIssues"] = () =>
    Effect.succeed([])

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
    listCiGateCatalog: () => Effect.succeed([...catalog]),
    observeCiGate: (repository, input, options) =>
      observe(repository, input, options),
    listReadyIssues: (repository, options) =>
      listReadyIssues(repository, options),
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
      getPullRequestCheckStatus: unused,
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      markPullRequestReadyForReview: () => Effect.void,
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: () => Effect.void,
      closeOpenPullRequestsForBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
      listCiGateCatalog: () => Effect.succeed([]),
      observeCiGate: () =>
        Effect.succeed({ defaultBranch: "main", observations: [] }),
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
    listReadyIssues = () => Effect.succeed([])
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const addRepository = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: `/repos/acme/widgets-${String(Date.now())}.git`,
          isBare: true,
        })
      }),
    )

  const fetchCiGate = async (repositoryId: string) => {
    const response = await createGraphqlApi(runtime).fetch(
      graphqlRequest(ciGateQuery(repositoryId)),
    )
    const payload = (await response.json()) as {
      data: {
        repositories: ReadonlyArray<{
          id: string
          ciGate: {
            enabled: boolean
            status: string
            observedAt: string | null
            defaultBranch: string | null
            diagnostic: string | null
            definitions: ReadonlyArray<{
              identity: string
              displayLabel: string
              failureLatched: boolean
              diagnostic: string | null
              latestRun: {
                runIdentity: string
                htmlUrl: string | null
                rawStatus: string | null
                rawConclusion: string | null
                event: string | null
                headSha: string | null
                headRef: string | null
              } | null
            }>
            activeIncident: {
              status: string
              summary: string
              failedDefinitions: ReadonlyArray<{
                identity: string
                displayLabel: string
              }>
            } | null
            latestResolvedIncident: {
              status: string
              summary: string
              recoveryReason: string | null
              failedDefinitions: ReadonlyArray<{
                identity: string
                displayLabel: string
              }>
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
            selectedCiGateDefinitions { identity }
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
          selectedCiGateDefinitions: ReadonlyArray<{ identity: string }>
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

  test("empty selection disables the gate and save of a successful definition is Open", async () => {
    const repository = await addRepository()
    expect(await fetchCiGate(repository.id)).toMatchObject({
      enabled: false,
      status: "DISABLED",
      activeIncident: null,
    })

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "100:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })

    const saved = await saveSelection(repository.id, ["161335"])
    expect(saved.errors).toBeUndefined()
    expect(saved.data.updateRepositorySettings.ciGate).toEqual({
      status: "OPEN",
      enabled: true,
    })
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.defaultBranch).toBe("main")
    expect(gate.definitions[0]?.latestRun?.rawConclusion).toBe("success")
    expect(gate.definitions[0]?.latestRun?.htmlUrl).toContain("/actions/runs/")
    expect(gate.activeIncident).toBeNull()
  })

  test("failure latches Closed, pending does not clear it, and a newer success resolves the incident", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.definitions[0]?.failureLatched).toBe(true)
    expect(gate.activeIncident?.status).toBe("OPEN")
    expect(gate.activeIncident?.failedDefinitions).toEqual([
      { identity: "161335", displayLabel: "CI" },
    ])

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "201:1",
              rawStatus: "in_progress",
              rawConclusion: null,
            }),
            observedRun({
              runIdentity: "200:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.activeIncident?.status).toBe("OPEN")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "202:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
            observedRun({
              runIdentity: "200:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.status).toBe("RESOLVED")
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("NEWER_SUCCESS")
  })

  test("a run first seen as pending latches Closed when that same run later fails", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "500:1",
              rawStatus: "in_progress",
              rawConclusion: null,
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    expect((await fetchCiGate(repository.id)).status).toBe("OPEN")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "500:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.definitions[0]?.failureLatched).toBe(true)
    expect(gate.definitions[0]?.latestRun?.rawConclusion).toBe("failure")
    expect(gate.activeIncident?.status).toBe("OPEN")
  })

  test("later observation tells GitHub the last-seen run identity", async () => {
    const repository = await addRepository()
    const seenLastRunIdentities: Array<{
      readonly [identity: string]: string
    }> = []
    observe = (_repo, input) => {
      seenLastRunIdentities.push(input.lastRunIdentities)
      return Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "100:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    }
    await saveSelection(repository.id, ["161335"])
    expect(seenLastRunIdentities[0]).toEqual({})
    await refresh(repository.id)
    expect(seenLastRunIdentities[1]).toEqual({ "161335": "100:1" })
  })

  test("a pending rerun that later succeeds clears the failure latch", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:2",
              rawStatus: "in_progress",
              rawConclusion: null,
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:2",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("NEWER_SUCCESS")
  })

  test("a pending rerun of a failed run stays Closed even when older success remains in history", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
            observedRun({
              runIdentity: "199:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "200:2",
              rawStatus: "in_progress",
              rawConclusion: null,
            }),
            observedRun({
              runIdentity: "199:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.activeIncident?.status).toBe("OPEN")
    expect(gate.definitions[0]?.latestRun?.runIdentity).toBe("200:2")
  })

  test("timeout and action-required conclusions latch Closed while canceled does not", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "900:1",
              rawStatus: "completed",
              rawConclusion: "timed_out",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "901:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("OPEN")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "902:1",
              rawStatus: "completed",
              rawConclusion: "action_required",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("269289", [
            observedRun({
              runIdentity: "903:1",
              rawStatus: "completed",
              rawConclusion: "cancelled",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["269289"])
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.definitions[0]?.failureLatched).toBe(false)
  })

  test("a failure and later success first seen together become a resolved incident without leaving Closed", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "301:1",
              rawStatus: "completed",
              rawConclusion: "success",
              createdAt: "2026-09-07T13:00:00.000Z",
            }),
            observedRun({
              runIdentity: "300:1",
              rawStatus: "completed",
              rawConclusion: "failure",
              createdAt: "2026-09-07T12:00:00.000Z",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.status).toBe("RESOLVED")
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("NEWER_SUCCESS")
  })

  test("Closed outranks a later permission error, which otherwise degrades an Open gate", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "400:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    observe = () =>
      Effect.fail(
        new GitHubRequestError({
          message:
            "Failed to observe CI Gate Definitions for acme/widgets: Actions read required",
          statusCode: 403,
          retryable: false,
        }),
      )
    await refresh(repository.id)
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DEGRADED")
    expect(gate.diagnostic).toContain("Actions read required")
    expect(gate.activeIncident).toBeNull()

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "401:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    observe = () =>
      Effect.fail(
        new GitHubRequestError({
          message:
            "Failed to observe CI Gate Definitions for acme/widgets: Actions read required",
          statusCode: 403,
          retryable: false,
        }),
      )
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.activeIncident?.status).toBe("OPEN")
  })

  test("removing a failed definition or clearing the selection resolves with an attributable reason", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "500:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
          observedDefinition("269289", [
            observedRun({
              runIdentity: "600:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335", "269289"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("269289", [
            observedRun({
              runIdentity: "600:1",
              rawStatus: "completed",
              rawConclusion: "success",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["269289"])
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.latestResolvedIncident?.recoveryReason).toBe(
      "DEFINITION_REMOVED",
    )

    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("269289", [
            observedRun({
              runIdentity: "601:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")
    await saveSelection(repository.id, [])
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DISABLED")
    expect(gate.enabled).toBe(false)
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("EMPTY_SELECTION")
  })

  test("a default-branch change clears old latches and starts an optimistic baseline", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "main",
        observations: [
          observedDefinition("161335", [
            observedRun({
              runIdentity: "700:1",
              rawStatus: "completed",
              rawConclusion: "failure",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["161335"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "develop",
        observations: [observedDefinition("161335", [])],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.defaultBranch).toBe("develop")
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.recoveryReason).toBe(
      "DEFAULT_BRANCH_CHANGED",
    )
    expect(gate.definitions[0]?.diagnostic).toBe("Not observed yet")
  })
})
