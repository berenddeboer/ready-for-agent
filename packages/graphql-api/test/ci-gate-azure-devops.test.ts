import { Duration, Effect, Layer, ManagedRuntime } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  missingSessionTelemetry,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import {
  AzureDevOpsRequestError,
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "@ready-for-agent/azure-devops-service"
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
import { QueueService, makeJobId } from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import { WorkItemLifecycle } from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi, observeRepositoryCiGate } from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const unused = () => Effect.die("not used")

const catalog = [
  {
    identity: "12",
    displayLabel: "CI",
    kind: "build-pipeline",
    diagnosticMetadata:
      "\\CI · build · enabled · rev 3 · https://dev.azure.com/acme/widgets/_build?definitionId=12",
  },
  {
    identity: "13",
    displayLabel: "Nightly",
    kind: "build-pipeline",
    diagnosticMetadata:
      "\\Nightly · build · enabled · rev 1 · https://dev.azure.com/acme/widgets/_build?definitionId=13",
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
  htmlUrl: `https://dev.azure.com/acme/widgets/_build/results?buildId=${input.runIdentity.split(":")[0] ?? input.runIdentity}`,
  headSha: `sha-${input.runIdentity}`,
  headRef: "refs/heads/main",
  event: input.event ?? "individualCI",
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

describe("Azure DevOps Repository CI Gate", () => {
  let observe: AzureDevOpsServiceShape["observeCiGate"] = () =>
    Effect.succeed({ defaultBranch: "refs/heads/main", observations: [] })
  let pullRequestCheckCalls = 0

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
    observeCiGate: () =>
      Effect.succeed({ defaultBranch: "main", observations: [] }),
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
    Layer.succeed(AzureDevOpsService, {
      verifyProject: (repository) => Effect.succeed(repository),
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      listCiGateCatalog: () => Effect.succeed([...catalog]),
      observeCiGate: (repository, input) => observe(repository, input),
      hasCredentials: () => Effect.succeed(true),
      hasAmbientCredentials: () => Effect.succeed(true),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(null),
      createDraftPullRequest: () => Effect.succeed(1),
      ensurePullRequestLinkedToIssue: () => Effect.void,
      updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () => {
        pullRequestCheckCalls += 1
        return Effect.succeed({
          _tag: "succeeded" as const,
          terminalChecks: [
            {
              externalId: "azure-policy:eval-1",
              name: "Build validation",
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
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
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
    observe = () =>
      Effect.succeed({ defaultBranch: "refs/heads/main", observations: [] })
    pullRequestCheckCalls = 0
    runtime = ManagedRuntime.make(runtimeLayer)
  })

  const addRepository = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.addRepository({
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "acme/widgets",
          localPath: `/repos/acme/widgets-${String(Date.now())}.git`,
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
            selectedCiGateDefinitions { identity kind }
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
            kind: string
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

  test("selecting an Azure pipeline observes Open, then failed and partiallySucceeded close the gate until a newer success", async () => {
    const repository = await addRepository()
    expect(await fetchCiGate(repository.id)).toMatchObject({
      enabled: false,
      status: "DISABLED",
      activeIncident: null,
    })

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "100:20260907.100",
              rawStatus: "completed",
              rawConclusion: "succeeded",
            }),
          ]),
        ],
      })
    const saved = await saveSelection(repository.id, ["12"])
    expect(saved.errors).toBeUndefined()
    expect(
      saved.data.updateRepositorySettings.selectedCiGateDefinitions,
    ).toEqual([{ identity: "12", kind: "build-pipeline" }])
    expect(saved.data.updateRepositorySettings.ciGate).toEqual({
      status: "OPEN",
      enabled: true,
    })
    expect((await fetchCiGate(repository.id)).defaultBranch).toBe(
      "refs/heads/main",
    )

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "101:20260907.101",
              rawStatus: "completed",
              rawConclusion: "failed",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.definitions[0]?.failureLatched).toBe(true)
    expect(gate.activeIncident?.failedDefinitions).toEqual([
      { identity: "12", displayLabel: "CI" },
    ])

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "102:20260907.102",
              rawStatus: "completed",
              rawConclusion: "partiallySucceeded",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "103:20260907.103",
              rawStatus: "completed",
              rawConclusion: "succeeded",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.activeIncident).toBeNull()
    expect(gate.latestResolvedIncident?.recoveryReason).toBe("NEWER_SUCCESS")
  })

  test("canceled, notStarted, postponed, and inProgress do not close an otherwise Open gate", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "200:20260907.200",
              rawStatus: "completed",
              rawConclusion: "canceled",
            }),
            observedRun({
              runIdentity: "199:20260907.199",
              rawStatus: "notStarted",
              rawConclusion: "none",
            }),
            observedRun({
              runIdentity: "198:20260907.198",
              rawStatus: "postponed",
              rawConclusion: null,
            }),
            observedRun({
              runIdentity: "197:20260907.197",
              rawStatus: "inProgress",
              rawConclusion: null,
            }),
            observedRun({
              runIdentity: "196:20260907.196",
              rawStatus: "cancelling",
              rawConclusion: null,
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["12"])
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("OPEN")
    expect(gate.definitions[0]?.failureLatched).toBe(false)
    expect(gate.activeIncident).toBeNull()
  })

  test("a saved pipeline that later becomes unavailable stays listed as Degraded", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "250:20260907.250",
              rawStatus: "completed",
              rawConclusion: "succeeded",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["12"])
    expect((await fetchCiGate(repository.id)).status).toBe("OPEN")

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          {
            identity: "12",
            kind: "unavailable",
            reason: "not_found",
            message: "CI Gate Definition 12 could not be observed",
          },
        ],
      })
    await refresh(repository.id)
    const gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DEGRADED")
    expect(gate.enabled).toBe(true)
    expect(gate.definitions).toEqual([
      expect.objectContaining({
        identity: "12",
        displayLabel: "CI",
        failureLatched: false,
        diagnostic: "CI Gate Definition 12 could not be observed",
      }),
    ])
    expect(gate.activeIncident).toBeNull()
  })

  test("a permission failure degrades Open and cannot clear an existing Closed latch", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "300:20260907.300",
              rawStatus: "completed",
              rawConclusion: "succeeded",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["12"])
    observe = () =>
      Effect.fail(
        new AzureDevOpsRequestError({
          message:
            "Failed to observe CI Gate Definitions for acme/widgets: Build read required",
          statusCode: 403,
        }),
      )
    await refresh(repository.id)
    let gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("DEGRADED")
    expect(gate.diagnostic).toContain("Build read required")
    expect(gate.activeIncident).toBeNull()

    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "301:20260907.301",
              rawStatus: "completed",
              rawConclusion: "failed",
            }),
          ]),
        ],
      })
    await refresh(repository.id)
    observe = () =>
      Effect.fail(
        new AzureDevOpsRequestError({
          message:
            "Failed to observe CI Gate Definitions for acme/widgets: Build read required",
          statusCode: 403,
        }),
      )
    await refresh(repository.id)
    gate = await fetchCiGate(repository.id)
    expect(gate.status).toBe("CLOSED")
    expect(gate.activeIncident?.status).toBe("OPEN")
  })

  test("later observation tells Azure the last-seen build identity", async () => {
    const repository = await addRepository()
    const seenLastRunIdentities: Array<{
      readonly [identity: string]: string
    }> = []
    observe = (_repo, input) => {
      seenLastRunIdentities.push(input.lastRunIdentities)
      return Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "400:20260907.400",
              rawStatus: "completed",
              rawConclusion: "succeeded",
            }),
          ]),
        ],
      })
    }
    await saveSelection(repository.id, ["12"])
    expect(seenLastRunIdentities[0]).toEqual({})
    await refresh(repository.id)
    expect(seenLastRunIdentities[1]).toEqual({ "12": "400:20260907.400" })
  })

  test("PR Status Check aggregation stays on the Azure policy path and is not used as the CI Gate", async () => {
    const repository = await addRepository()
    observe = () =>
      Effect.succeed({
        defaultBranch: "refs/heads/main",
        observations: [
          observedDefinition("12", [
            observedRun({
              runIdentity: "500:20260907.500",
              rawStatus: "completed",
              rawConclusion: "failed",
            }),
          ]),
        ],
      })
    await saveSelection(repository.id, ["12"])
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")
    expect(pullRequestCheckCalls).toBe(0)

    const status = await runtime.runPromise(
      Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        return yield* azureDevOps.getPullRequestCheckStatus(
          repository,
          "feature",
        )
      }),
    )
    expect(status._tag).toBe("succeeded")
    expect(status.terminalChecks).toEqual([
      {
        externalId: "azure-policy:eval-1",
        name: "Build validation",
        outcome: "green",
      },
    ])
    expect(pullRequestCheckCalls).toBe(1)
    expect((await fetchCiGate(repository.id)).status).toBe("CLOSED")
  })
})
