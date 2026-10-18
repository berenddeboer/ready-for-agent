import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Result,
} from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { DatabaseTest, makeFileDatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import type { CiGateObservation } from "@ready-for-agent/forge-contract"
import { disabledKeymaxxerLayer } from "@ready-for-agent/keymaxxer-service"
import {
  LinearService,
  defaultLinearServiceShape,
} from "@ready-for-agent/linear-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  SharedAgentTurnAdmission,
  SharedAgentTurnAdmissionLive,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "@ready-for-agent/work-item-lifecycle"
import { createGraphqlApi, observeRepositoryCiGate } from "../src/index.js"
import {
  CI_REPAIR_BUDGET_MS,
  type CiRepairExecution,
  CiRepairExecutor,
  RepositoryCiRepair,
  RepositoryCiRepairLive,
  makeRepositoryCiRepair,
} from "../src/lib/repository-ci-repair.js"
import { afterEach, describe, expect, test } from "bun:test"

const catalog = [
  {
    identity: "161335",
    displayLabel: "CI",
    kind: "workflow",
    diagnosticMetadata: ".github/workflows/ci.yml",
  },
] as const

const observedRun = (
  runIdentity: string,
  rawConclusion: string,
): CiGateObservation["observations"][number] extends infer Observation
  ? Observation extends { readonly kind: "observed" }
    ? Observation["runs"][number]
    : never
  : never => ({
  runIdentity,
  htmlUrl: `https://github.com/acme/widgets/actions/runs/${runIdentity.split(":")[0] ?? runIdentity}`,
  headSha: `sha-${runIdentity}`,
  headRef: "main",
  event: "push",
  createdAt: new Date("2026-09-07T12:00:00.000Z"),
  updatedAt: new Date("2026-09-07T12:05:00.000Z"),
  startedAt: new Date("2026-09-07T12:00:01.000Z"),
  rawStatus: "completed",
  rawConclusion,
})

const failureObservation = (
  runIdentity = "100:1",
  defaultBranch = "main",
): CiGateObservation => ({
  defaultBranch,
  observations: [
    {
      identity: "161335",
      kind: "observed",
      runs: [observedRun(runIdentity, "failure")],
    },
  ],
})

const pendingObservation = (): CiGateObservation => ({
  defaultBranch: "main",
  observations: [
    {
      identity: "161335",
      kind: "observed",
      runs: [
        {
          ...observedRun("100:1", "failure"),
          rawStatus: "in_progress",
          rawConclusion: null,
        },
      ],
    },
  ],
})

const successObservation = (runIdentity = "101:1"): CiGateObservation => ({
  defaultBranch: "main",
  observations: [
    {
      identity: "161335",
      kind: "observed",
      runs: [
        observedRun(runIdentity, "success"),
        observedRun("100:1", "failure"),
      ],
    },
  ],
})

const steps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/repair",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_unused"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () =>
    Effect.succeed({
      _tag: "committed" as const,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why",
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 1,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why",
    }),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded" as const,
      createdAt: new Date(0),
      headSha: "head",
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

type RepairControl = {
  mode: "finish" | "block"
  assistantText: string
  prompts: string[]
  kills: string[]
  release: Deferred.Deferred<void> | null
  entered: Deferred.Deferred<void> | null
  /** When false, restart reconciliation still sees the previous process. */
  reportStopped: boolean
}

const control: RepairControl = {
  mode: "finish",
  assistantText: "",
  prompts: [],
  kills: [],
  release: null,
  entered: null,
  reportStopped: true,
}

const resetControl = () => {
  control.mode = "finish"
  control.assistantText = ""
  control.prompts = []
  control.kills = []
  control.release = null
  control.entered = null
  control.reportStopped = true
}

let observe = (): Effect.Effect<CiGateObservation> =>
  Effect.succeed({ defaultBranch: "main", observations: [] })

const executorLayer = Layer.succeed(
  CiRepairExecutor,
  CiRepairExecutor.of({
    run: (input: CiRepairExecution) =>
      Effect.gen(function* () {
        control.prompts.push(input.prompt)
        if (control.entered !== null) {
          yield* Deferred.succeed(control.entered, undefined).pipe(
            Effect.ignore,
          )
        }
        yield* input.onSessionId("ses-ci-repair")
        if (control.mode === "block" && control.release !== null) {
          yield* Effect.uninterruptible(Deferred.await(control.release))
        }
        return {
          sessionId: "ses-ci-repair",
          assistantText: control.assistantText,
        }
      }),
    kill: (processRef) =>
      Effect.gen(function* () {
        control.kills.push(processRef)
        if (control.release !== null) {
          yield* Deferred.succeed(control.release, undefined).pipe(
            Effect.ignore,
          )
        }
      }),
    stopped: () => Effect.succeed(control.reportStopped),
  }),
)

const makeRuntimeLayer = (database = DatabaseTest) =>
  Layer.mergeAll(
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(
        stubGitHubServiceLayer({
          observeCiGate: () => observe(),
          listCiGateCatalog: () => Effect.succeed([...catalog]),
        }),
      ),
      Layer.provideMerge(
        stubGitLabServiceLayer({
          observeCiGate: () => observe(),
          listCiGateCatalog: () => Effect.succeed([...catalog]),
        }),
      ),
      Layer.provideMerge(
        stubAzureDevOpsServiceLayer({
          observeCiGate: () => observe(),
          listCiGateCatalog: () => Effect.succeed([...catalog]),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      // Admission needs the database. Provide it before the database layers so
      // those later layers satisfy the leaked requirement; providing it after
      // leaves the runtime without DbService.
      Layer.provideMerge(SharedAgentTurnAdmissionLive),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(database),
      Layer.provideMerge(
        Layer.succeed(LinearService, defaultLinearServiceShape),
      ),
      Layer.provideMerge(executorLayer),
    ),
    disabledKeymaxxerLayer,
    stubActiveAgentBackendLayer(),
    Layer.succeed(LinearService, defaultLinearServiceShape),
    Layer.succeed(LocalGit, {
      inspect: (path) =>
        Effect.succeed({
          forge: "github" as const,
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
  resetControl()
  observe = () => Effect.succeed({ defaultBranch: "main", observations: [] })
  runtime = ManagedRuntime.make(runtimeLayer)
})

const graphqlRequest = (body: unknown) =>
  new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// Date.now() alone collides when two repositories are seeded in the same
// millisecond (GitHub, GitLab, and Azure rows in one view).
let localPathSeq = 0

const seedRepository = (
  input: {
    readonly forge?: "github" | "gitlab" | "azure-devops"
    readonly paused?: boolean
    readonly maxConcurrentAgentTurns?: number
    readonly projectPath?: string
    readonly forgeHost?: string
    readonly backend?: string
    readonly repositoryBackend?: string | null
  } = {},
  target: typeof runtime = runtime,
) =>
  target.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService
      const config = yield* db.getConfig
      yield* db.updateConfig({
        selectedAgentBackend: input.backend ?? "opencode",
        defaultModel: "opencode/deepseek-v4-flash-free",
        defaultThinkingLevel: "low",
        reviewModel: config.reviewModel,
        reviewThinkingLevel: config.reviewThinkingLevel,
        maxConcurrentAgentTurns:
          input.maxConcurrentAgentTurns ?? config.maxConcurrentAgentTurns,
        maxConcurrentWorkItems: config.maxConcurrentWorkItems,
      })
      const forge = input.forge ?? "github"
      const repository = yield* db.addRepository({
        forge,
        forgeHost: input.forgeHost ?? "github.com",
        projectPath: input.projectPath ?? "acme/widgets",
        localPath: `/repos/${input.projectPath ?? "acme/widgets"}-${String(Date.now())}-${String(++localPathSeq)}.git`,
        isBare: true,
      })
      yield* db.updateRepositorySettings({
        repositoryId: repository.id,
        paused: input.paused ?? false,
        ...(input.repositoryBackend !== undefined
          ? { selectedAgentBackend: input.repositoryBackend }
          : {}),
        defaultModel: "opencode/deepseek-v4-flash-free",
        defaultThinkingLevel: "low",
        reviewModel: null,
        reviewThinkingLevel: null,
        mergePolicy: "classify",
        includeAllIssueAuthors: false,
        waitForReadyForReviewChecks: true,
        selectedCiGateDefinitions: [...catalog],
      })
      return repository
    }),
  )

const closeGate = (
  repository: RepositoryRecord,
  target: typeof runtime = runtime,
) => {
  observe = () => Effect.succeed(failureObservation())
  return target.runPromise(
    observeRepositoryCiGate({ repository, origin: "operator" }),
  )
}

const degradeGate = (
  repository: RepositoryRecord,
  target: typeof runtime = runtime,
) => {
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
  return target.runPromise(
    observeRepositoryCiGate({ repository, origin: "operator" }),
  )
}

const invocationCount = (
  repositoryId: string,
  target: typeof runtime = runtime,
) =>
  target.runPromise(
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      const rows = (yield* client.unsafe(
        `SELECT id FROM ci_repair_invocation WHERE repository_id = ?`,
        [repositoryId],
      )) as readonly { readonly id: string }[]
      const workItems = (yield* client.unsafe(
        `SELECT id FROM work_item WHERE repository_id = ?`,
        [repositoryId],
      )) as readonly { readonly id: string }[]
      return { repairs: rows.length, workItems: workItems.length }
    }),
  )

const setAutomatic = (
  repository: RepositoryRecord,
  enabled: boolean,
  target: typeof runtime = runtime,
  paused?: boolean,
) =>
  target.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService
      const current = (yield* db.listRepositories).find(
        (item) => item.id === repository.id,
      )
      if (current === undefined) {
        return yield* Effect.die(`Repository ${repository.id} is missing`)
      }
      return yield* db.updateRepositorySettings({
        repositoryId: current.id,
        paused: paused ?? current.paused,
        defaultModel: current.defaultModel,
        defaultThinkingLevel: current.defaultThinkingLevel,
        reviewModel: current.reviewModel,
        reviewThinkingLevel: current.reviewThinkingLevel,
        mergePolicy: current.mergePolicy,
        includeAllIssueAuthors: current.includeAllIssueAuthors,
        waitForReadyForReviewChecks: current.waitForReadyForReviewChecks,
        automaticCiRepair: enabled,
      })
    }),
  )

const consider = (repositoryId: string, target: typeof runtime = runtime) =>
  target.runPromise(
    Effect.gen(function* () {
      const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
      return yield* repair.considerAutomatic(repositoryId)
    }),
  )

const openIncidentId = (
  repositoryId: string,
  target: typeof runtime = runtime,
) =>
  target.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService
      const snapshot = yield* db.loadCiGateSnapshot(repositoryId)
      return snapshot.activeIncident?.id ?? null
    }),
  )

const automaticEligibility = (
  incidentId: string,
  target: typeof runtime = runtime,
) =>
  target.runPromise(
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      const rows = (yield* client.unsafe(
        `SELECT automatic_repair_eligible AS eligible
         FROM ci_failure_incident WHERE id = ?`,
        [incidentId],
      )) as readonly { readonly eligible: number | boolean }[]
      const eligible = rows[0]?.eligible
      return eligible === true || eligible === 1
    }),
  )

describe("manual repository CI repair", () => {
  test("starts only for a current Closed GitHub incident, including while paused", async () => {
    const openRepository = await seedRepository()
    const openResult = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(openRepository.id).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(openResult)).toBe(true)
    if (Result.isFailure(openResult)) {
      expect(openResult.failure).toMatchObject({
        _tag: "CiRepairNotEligibleError",
      })
    }
    expect((await invocationCount(openRepository.id)).repairs).toBe(0)

    const degraded = await seedRepository({ projectPath: "acme/degraded" })
    await degradeGate(degraded)
    const degradedResult = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(degraded.id).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(degradedResult)).toBe(true)
    expect((await invocationCount(degraded.id)).repairs).toBe(0)

    const gitlab = await seedRepository({
      forge: "gitlab",
      forgeHost: "gitlab.com",
      projectPath: "acme/widgets",
    })
    await closeGate(gitlab)
    const gitlabResult = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(gitlab.id).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(gitlabResult)).toBe(true)
    if (Result.isFailure(gitlabResult)) {
      expect(gitlabResult.failure).toMatchObject({
        _tag: "CiRepairNotSupportedError",
      })
    }
    expect((await invocationCount(gitlab.id)).repairs).toBe(0)

    const paused = await seedRepository({
      paused: true,
      projectPath: "acme/paused",
    })
    await closeGate(paused)
    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(paused.id)
      }),
    )
    expect(started.status).toBe("queued")
    expect(started.launchedAt).toBeNull()
    expect((await invocationCount(paused.id)).workItems).toBe(0)
  })

  test("manual start launches the agent without a separate drive call", async () => {
    const repository = await seedRepository({ projectPath: "acme/auto" })
    await closeGate(repository)
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(repository.id)
        expect(queued.status).toBe("queued")
        expect(queued.launchedAt).toBeNull()
        yield* Effect.sleep("200 millis")
        return yield* repair.latestForRepository(repository.id)
      }),
    )
    expect(control.prompts).toHaveLength(1)
    expect(outcome?.status).toBe("unresolved")
    expect(outcome?.outcome).toBe("failed")
    expect(outcome?.launchedAt).not.toBeNull()
    expect((await invocationCount(repository.id)).workItems).toBe(0)
  })

  test("uses the repository backend override and refuses a backend that is not ready", async () => {
    const harnessUnready = await seedRepository({
      backend: "grok",
      projectPath: "acme/unready",
    })
    await closeGate(harnessUnready)
    const harnessResult = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(harnessUnready.id).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(harnessResult)).toBe(true)
    if (Result.isFailure(harnessResult)) {
      expect(harnessResult.failure).toMatchObject({
        _tag: "CiRepairNotReadyError",
      })
    }
    expect((await invocationCount(harnessUnready.id)).repairs).toBe(0)

    const overrideUnready = await seedRepository({
      projectPath: "acme/override-unready",
      repositoryBackend: "grok",
    })
    await closeGate(overrideUnready)
    const overrideResult = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(overrideUnready.id).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(overrideResult)).toBe(true)
    if (Result.isFailure(overrideResult)) {
      expect(overrideResult.failure).toMatchObject({
        _tag: "CiRepairNotReadyError",
      })
    }
    expect((await invocationCount(overrideUnready.id)).repairs).toBe(0)

    const overrideReady = await seedRepository({
      backend: "grok",
      projectPath: "acme/override-ready",
      repositoryBackend: "opencode",
    })
    await closeGate(overrideReady)
    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(overrideReady.id)
      }),
    )
    expect(started.status).toBe("queued")
    expect((await invocationCount(overrideReady.id)).workItems).toBe(0)
  })

  test("admits one queued repair when requests race", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* Effect.all(
          [
            repair.startManual(repository.id),
            repair.startManual(repository.id),
          ],
          { concurrency: "unbounded" },
        )
      }),
    )
    expect(first.id).toBe(second.id)
    expect((await invocationCount(repository.id)).repairs).toBe(1)
  })

  test("does not launch when the incident resolves while queued", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        const queued = yield* repair.startManual(repository.id)
        observe = () => Effect.succeed(successObservation())
        yield* observeRepositoryCiGate({ repository, origin: "operator" })
        yield* repair.drive(queued.id)
        return yield* repair.latestForRepository(repository.id)
      }),
    )
    expect(control.prompts).toHaveLength(0)
    expect(outcome?.status).toBe("recovered")
    expect(outcome?.outcome).toBe("recovered")
    expect(outcome?.launchedAt).toBeNull()
  })

  test("a replacement Closed incident does not count as recovery", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        const queued = yield* repair.startManual(repository.id)
        observe = () => Effect.succeed(failureObservation("200:1", "release"))
        yield* repair.drive(queued.id)
        const db = yield* DbService
        return {
          repair: yield* repair.latestForRepository(repository.id),
          gate: yield* db.loadCiGateSnapshot(repository.id),
        }
      }),
    )
    expect(control.prompts).toHaveLength(0)
    expect(outcome.repair?.status).toBe("unresolved")
    expect(outcome.repair?.outcome).toBe("failed")
    expect(outcome.repair?.launchedAt).toBeNull()
    expect(outcome.repair?.report).not.toContain("reopened the gate")
    expect(outcome.repair?.report).toContain("still reports Closed")
    expect(outcome.gate.activeIncident?.status).toBe("open")
    expect(outcome.gate.activeIncident?.id).not.toBe(outcome.repair?.incidentId)
  })

  test("a running repair stops without recovery when a new Closed incident replaces it", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    control.mode = "block"
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        control.release = yield* Deferred.make<void>()
        control.entered = yield* Deferred.make<void>()
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.seconds(1),
        })
        const queued = yield* repair.startManual(repository.id)
        const drive = yield* repair.drive(queued.id).pipe(Effect.forkChild)
        yield* Deferred.await(control.entered as Deferred.Deferred<void>)
        observe = () => Effect.succeed(failureObservation("200:1", "release"))
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(drive)
        const db = yield* DbService
        return {
          repair: yield* repair.latestForRepository(repository.id),
          gate: yield* db.loadCiGateSnapshot(repository.id),
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(control.kills.length).toBeGreaterThan(0)
    expect(outcome.repair?.status).toBe("unresolved")
    expect(outcome.repair?.outcome).toBe("failed")
    expect(outcome.repair?.report).not.toContain("reopened the gate")
    expect(outcome.gate.activeIncident?.status).toBe("open")
    expect(outcome.gate.activeIncident?.id).not.toBe(outcome.repair?.incidentId)
  })

  test("a later progress line settles a pull request and a remote job", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    const pullRequest = "https://github.com/acme/widgets/pull/18"
    const job = "https://github.com/acme/widgets/actions/runs/9"
    control.assistantText = [
      `CI_REPAIR_PR ${pullRequest} unfinished`,
      `CI_REPAIR_PR ${pullRequest} merged`,
      `CI_REPAIR_JOB ${job} active`,
      `CI_REPAIR_JOB ${job} completed`,
      pullRequest,
    ].join("\n")
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(repository.id)
        yield* repair.drive(queued.id)
        return yield* repair.latestForRepository(repository.id)
      }),
    )
    expect(first?.links).toEqual([
      { url: pullRequest, kind: "pull_request", disposition: "merged" },
      { url: job, kind: "remote_job", disposition: "completed" },
    ])
    expect(first?.report).toContain("Unfinished pull requests: none recorded.")
    expect(first?.report).toContain("Active remote jobs: none recorded.")

    control.prompts.length = 0
    const retried = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        yield* repair.drive((yield* repair.startManual(repository.id)).id)
        return control.prompts.at(-1) ?? ""
      }),
    )
    expect(retried).toContain(
      "Unfinished pull requests from earlier attempts\n- none recorded",
    )
    expect(retried).not.toContain(pullRequest)
  })

  test("waits for an ordinary agent slot and starts the four-hour budget at launch", async () => {
    const repository = await seedRepository({ maxConcurrentAgentTurns: 1 })
    await closeGate(repository)
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const admission = yield* SharedAgentTurnAdmission
        const release = yield* Deferred.make<void>()
        const holding = yield* Deferred.make<void>()
        let holderReleased = false
        yield* admission
          .withPermit(
            repository.id,
            Effect.gen(function* () {
              yield* Deferred.succeed(holding, undefined)
              yield* Deferred.await(release)
              holderReleased = true
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(holding)
        const queued = yield* repair.startManual(repository.id)
        const drive = yield* repair.drive(queued.id).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        const waiting = yield* repair.latestForRepository(repository.id)
        expect(waiting?.status).toBe("queued")
        expect(waiting?.launchedAt).toBeNull()
        expect(holderReleased).toBe(false)
        expect(control.prompts).toHaveLength(0)
        yield* Deferred.succeed(release, undefined)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(drive)
        expect(holderReleased).toBe(true)
        return yield* repair.latestForRepository(repository.id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(outcome?.launchedAt).not.toBeNull()
    expect(outcome?.deadlineAt).not.toBeNull()
    expect(
      (outcome?.launchedAt ?? 0) - (outcome?.admittedAt ?? 0),
    ).toBeGreaterThanOrEqual(1000)
    expect((outcome?.deadlineAt ?? 0) - (outcome?.launchedAt ?? 0)).toBe(
      CI_REPAIR_BUDGET_MS,
    )
    expect(control.prompts[0]).toContain("one manual repository CI repair")
    expect(control.prompts[0]).toContain("repair-ci-cd-pipeline")
    expect(control.prompts[0]).toContain("Do not switch to a review model")
    expect(control.prompts[0]).toContain("Absolute deadline:")
    expect(control.prompts[0]).toContain("gh CLI")
    expect((await invocationCount(repository.id)).workItems).toBe(0)
  })

  test("stops a non-cooperating agent at the deadline and leaves the gate Closed", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    control.mode = "block"
    control.assistantText =
      "The pipeline is green. https://github.com/acme/widgets/pull/7"
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        control.release = yield* Deferred.make<void>()
        control.entered = yield* Deferred.make<void>()
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(repository.id)
        const drive = yield* repair.drive(queued.id).pipe(Effect.forkChild)
        // Wait until the agent is inside the turn so the deadline sleep is
        // registered before the clock jumps. Adjusting first schedules that
        // sleep after the jump and the join never finishes.
        yield* Deferred.await(control.entered as Deferred.Deferred<void>)
        yield* TestClock.adjust(Duration.millis(CI_REPAIR_BUDGET_MS + 1000))
        yield* Fiber.join(drive)
        return yield* repair.latestForRepository(repository.id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(outcome?.outcome).toBe("timed_out")
    expect(outcome?.status).toBe("unresolved")
    expect(outcome?.localExecutionStopped).toBe(true)
    expect(control.kills.length).toBeGreaterThan(0)
    expect(outcome?.report).toContain("Local execution: stopped.")
    expect(outcome?.report).toContain("https://github.com/acme/widgets/pull/7")
    const gate = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.loadCiGateSnapshot(repository.id)
      }),
    )
    expect(gate.activeIncident?.status).toBe("open")
  })

  test("agent success does not clear a Closed gate, and retry sees unfinished pull requests", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    control.assistantText =
      "Merged the fix. https://github.com/acme/widgets/pull/18"
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(repository.id)
        yield* repair.drive(queued.id)
        return yield* repair.latestForRepository(repository.id)
      }),
    )
    expect(first?.outcome).toBe("failed")
    expect(first?.status).toBe("unresolved")
    expect(first?.links.some((link) => link.url.endsWith("/pull/18"))).toBe(
      true,
    )
    expect((await invocationCount(repository.id)).workItems).toBe(0)

    control.prompts.length = 0
    const retried = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(repository.id)
        yield* repair.drive(queued.id)
        return {
          queued,
          latest: yield* repair.latestForRepository(repository.id),
        }
      }),
    )
    expect(retried.queued.id).not.toBe(first?.id)
    expect(retried.latest?.outcome).toBe("failed")
    expect(
      (retried.latest?.deadlineAt ?? 0) - (retried.latest?.launchedAt ?? 0),
    ).toBe(CI_REPAIR_BUDGET_MS)
    expect(control.prompts.at(-1)).toContain(
      "https://github.com/acme/widgets/pull/18",
    )
  })

  test("the gate observer recovers the invocation, including a fix by someone else", async () => {
    const repository = await seedRepository()
    await closeGate(repository)
    control.mode = "block"
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        control.release = yield* Deferred.make<void>()
        control.entered = yield* Deferred.make<void>()
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.seconds(1),
        })
        const queued = yield* repair.startManual(repository.id)
        const drive = yield* repair.drive(queued.id).pipe(Effect.forkChild)
        yield* Deferred.await(control.entered as Deferred.Deferred<void>)
        observe = () => Effect.succeed(successObservation())
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(drive)
        return yield* repair.latestForRepository(repository.id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(outcome?.outcome).toBe("recovered")
    expect(outcome?.status).toBe("recovered")
    expect(control.kills.length).toBeGreaterThan(0)
    const gate = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db.loadCiGateSnapshot(repository.id)
      }),
    )
    expect(gate.activeIncident).toBeNull()
  })

  test("restart does not resume, and a new attempt waits until the old process has stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-repair-restart-"))
    const filename = join(dir, "harness.sqlite")
    const firstLayer = makeRuntimeLayer(makeFileDatabaseTest(filename))
    const firstRuntime = ManagedRuntime.make(firstLayer)
    let repositoryId = ""
    try {
      const repository = await seedRepository(
        { projectPath: "acme/restart" },
        firstRuntime,
      )
      repositoryId = repository.id
      await closeGate(repository, firstRuntime)
      await firstRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const repair = yield* makeRepositoryCiRepair({
            autoDrive: false,
            epoch: "epoch-a",
          })
          const queued = yield* repair.startManual(repository.id)
          const now = Date.now()
          yield* sql.unsafe(
            `UPDATE ci_repair_invocation
             SET status = 'running',
                 process_ref = 'cirp-previous',
                 launched_at = ?,
                 deadline_at = ?,
                 updated_at = ?
             WHERE id = ?`,
            [now, now + CI_REPAIR_BUDGET_MS, now, queued.id],
          )
        }),
      )
    } finally {
      await firstRuntime.dispose()
    }

    resetControl()
    control.reportStopped = false
    const secondRuntime = ManagedRuntime.make(
      makeRuntimeLayer(makeFileDatabaseTest(filename)),
    )
    try {
      const blocked = await secondRuntime.runPromise(
        Effect.gen(function* () {
          const repair = yield* makeRepositoryCiRepair({
            autoDrive: false,
            epoch: "epoch-b",
            pollInterval: Duration.hours(5),
          })
          const firstPass = yield* repair.reconcile()
          const refused = yield* repair
            .startManual(repositoryId)
            .pipe(Effect.result)
          control.reportStopped = true
          const secondPass = yield* repair.reconcile()
          const retried = yield* repair.startManual(repositoryId)
          return { firstPass, refused, secondPass, retried }
        }),
      )
      expect(blocked.firstPass.blockedRepositoryIds).toContain(repositoryId)
      expect(Result.isFailure(blocked.refused)).toBe(true)
      if (Result.isFailure(blocked.refused)) {
        expect(blocked.refused.failure).toMatchObject({
          _tag: "CiRepairProcessStillRunningError",
        })
      }
      expect(blocked.secondPass.blockedRepositoryIds).not.toContain(
        repositoryId,
      )
      expect(blocked.retried.status).toBe("queued")
      expect(blocked.retried.id.startsWith("criv-")).toBe(true)
    } finally {
      await secondRuntime.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("GraphQL start and the repository CI view report the outcome", async () => {
    const graphqlRuntime = ManagedRuntime.make(
      RepositoryCiRepairLive({
        autoDrive: false,
        pollInterval: Duration.hours(5),
      }).pipe(Layer.provideMerge(runtimeLayer)),
    )
    try {
      const repository = await seedRepository({}, graphqlRuntime)
      await closeGate(repository, graphqlRuntime)
      control.assistantText =
        "Still red. https://github.com/acme/widgets/pull/4"
      const started = await createGraphqlApi(graphqlRuntime).fetch(
        graphqlRequest({
          query: `mutation Start($repositoryId: ID!) {
            startRepositoryCiRepair(repositoryId: $repositoryId) {
              id
              status
              launchedAt
              localExecutionStopped
            }
          }`,
          variables: { repositoryId: repository.id },
        }),
      )
      const startedPayload = (await started.json()) as {
        data?: {
          startRepositoryCiRepair: {
            id: string
            status: string
            launchedAt: string | null
            localExecutionStopped: boolean
          }
        }
        errors?: unknown
      }
      expect(startedPayload.errors).toBeUndefined()
      expect(startedPayload.data?.startRepositoryCiRepair.status).toBe("QUEUED")
      expect(startedPayload.data?.startRepositoryCiRepair.launchedAt).toBeNull()

      await graphqlRuntime.runPromise(
        Effect.gen(function* () {
          const repair = yield* RepositoryCiRepair
          yield* repair.drive(
            startedPayload.data?.startRepositoryCiRepair.id ?? "",
          )
        }),
      )

      const gitlab = await seedRepository(
        {
          forge: "gitlab",
          forgeHost: "gitlab.com",
          projectPath: "acme/widgets",
        },
        graphqlRuntime,
      )
      await closeGate(gitlab, graphqlRuntime)
      const azure = await seedRepository(
        {
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "acme/widgets",
        },
        graphqlRuntime,
      )
      await closeGate(azure, graphqlRuntime)

      const listed = await createGraphqlApi(graphqlRuntime).fetch(
        graphqlRequest({
          query: `query Gate {
            repositories {
              id
              forge
              ciGate {
                status
                repairSupported
                repair {
                  status
                  requestSource
                  outcome
                  localExecutionStopped
                  report
                  links { url kind disposition }
                }
              }
            }
          }`,
        }),
      )
      const listedPayload = (await listed.json()) as {
        data?: {
          repositories: ReadonlyArray<{
            id: string
            forge: string
            ciGate: {
              status: string
              repairSupported: boolean
              repair: {
                status: string
                requestSource: string
                outcome: string | null
                localExecutionStopped: boolean
                report: string | null
                links: ReadonlyArray<{ url: string; disposition: string }>
              } | null
            }
          }>
        }
        errors?: unknown
      }
      expect(listedPayload.errors).toBeUndefined()
      const gate = listedPayload.data?.repositories.find(
        (item) => item.id === repository.id,
      )?.ciGate
      expect(gate?.repairSupported).toBe(true)
      expect(gate?.repair?.requestSource).toBe("MANUAL")
      expect(gate?.repair?.status).toBe("UNRESOLVED")
      expect(gate?.repair?.outcome).toBe("FAILED")
      expect(gate?.repair?.localExecutionStopped).toBe(true)
      expect(gate?.repair?.report).toContain("Local execution: stopped.")
      expect(gate?.repair?.links[0]?.url).toContain("/pull/4")
      for (const otherId of [gitlab.id, azure.id]) {
        const other = listedPayload.data?.repositories.find(
          (item) => item.id === otherId,
        )
        expect(other?.ciGate.status).toBe("CLOSED")
        expect(other?.ciGate.repairSupported).toBe(false)
        expect(other?.ciGate.repair).toBeNull()
      }
    } finally {
      await graphqlRuntime.dispose()
    }
  })
})

describe("automatic repository CI repair", () => {
  test("stays off until a confirmed Closed GitHub incident is enabled", async () => {
    const repository = await seedRepository({ projectPath: "acme/auto-off" })
    await closeGate(repository)
    expect(await consider(repository.id)).toBeNull()
    expect((await invocationCount(repository.id)).repairs).toBe(0)

    await setAutomatic(repository, true)
    const queued = await consider(repository.id)
    expect(queued?.status).toBe("queued")
    expect(queued?.requestSource).toBe("automatic")
    expect(queued?.launchedAt).toBeNull()
    expect((await invocationCount(repository.id)).repairs).toBe(1)
    expect((await invocationCount(repository.id)).workItems).toBe(0)
    const incidentId = await openIncidentId(repository.id)
    expect(incidentId).not.toBeNull()
    expect(await automaticEligibility(incidentId ?? "")).toBe(false)
  })

  test("pending CI and Degraded observation do not enqueue", async () => {
    const pending = await seedRepository({ projectPath: "acme/auto-pending" })
    await setAutomatic(pending, true)
    observe = () => Effect.succeed(pendingObservation())
    await runtime.runPromise(
      observeRepositoryCiGate({ repository: pending, origin: "polling" }),
    )
    expect(await consider(pending.id)).toBeNull()
    expect((await invocationCount(pending.id)).repairs).toBe(0)

    const degraded = await seedRepository({ projectPath: "acme/auto-degraded" })
    await setAutomatic(degraded, true)
    await degradeGate(degraded)
    expect(await consider(degraded.id)).toBeNull()
    expect((await invocationCount(degraded.id)).repairs).toBe(0)
    const incidentId = await openIncidentId(degraded.id)
    expect(incidentId).toBeNull()
  })

  test("Paused skips automatic selection and still allows manual start", async () => {
    const repository = await seedRepository({
      paused: true,
      projectPath: "acme/auto-paused",
    })
    await setAutomatic(repository, true)
    await closeGate(repository)
    expect(await consider(repository.id)).toBeNull()
    const incidentId = await openIncidentId(repository.id)
    expect(await automaticEligibility(incidentId ?? "")).toBe(true)
    const manual = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(repository.id)
      }),
    )
    expect(manual.requestSource).toBe("manual")
    expect(manual.status).toBe("queued")

    const held = await seedRepository({
      paused: true,
      projectPath: "acme/auto-unpause",
    })
    await setAutomatic(held, true)
    await closeGate(held)
    expect(await consider(held.id)).toBeNull()
    await setAutomatic(held, true, runtime, false)
    const queued = await consider(held.id)
    expect(queued?.requestSource).toBe("automatic")
    expect(queued?.status).toBe("queued")
  })

  test("a not-ready backend does not consume the automatic attempt", async () => {
    const repository = await seedRepository({
      projectPath: "acme/auto-unready",
      repositoryBackend: "grok",
    })
    await setAutomatic(repository, true)
    await closeGate(repository)
    expect(await consider(repository.id)).toBeNull()
    expect((await invocationCount(repository.id)).repairs).toBe(0)
    const incidentId = await openIncidentId(repository.id)
    expect(await automaticEligibility(incidentId ?? "")).toBe(true)

    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const current = (yield* db.listRepositories).find(
          (item) => item.id === repository.id,
        )
        if (current === undefined) {
          return yield* Effect.die("missing")
        }
        yield* db.updateRepositorySettings({
          repositoryId: current.id,
          paused: current.paused,
          selectedAgentBackend: null,
          defaultModel: current.defaultModel,
          defaultThinkingLevel: current.defaultThinkingLevel,
          reviewModel: current.reviewModel,
          reviewThinkingLevel: current.reviewThinkingLevel,
          mergePolicy: current.mergePolicy,
          includeAllIssueAuthors: current.includeAllIssueAuthors,
          waitForReadyForReviewChecks: current.waitForReadyForReviewChecks,
          automaticCiRepair: true,
        })
      }),
    )
    const queued = await consider(repository.id)
    expect(queued?.status).toBe("queued")
    expect(queued?.requestSource).toBe("automatic")
  })

  test("repeated polls, extra failures, and a manual request share one repair", async () => {
    const repository = await seedRepository({ projectPath: "acme/auto-once" })
    await setAutomatic(repository, true)
    await closeGate(repository)
    const [first, second] = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* Effect.all(
          [
            repair.considerAutomatic(repository.id),
            repair.considerAutomatic(repository.id),
          ],
          { concurrency: "unbounded" },
        )
      }),
    )
    expect(first?.id).toBe(second?.id)
    expect((await invocationCount(repository.id)).repairs).toBe(1)

    const incidentId = await openIncidentId(repository.id)
    observe = () => Effect.succeed(failureObservation("100:2"))
    await runtime.runPromise(
      observeRepositoryCiGate({ repository, origin: "polling" }),
    )
    expect(await openIncidentId(repository.id)).toBe(incidentId)
    const again = await consider(repository.id)
    expect(again?.id).toBe(first?.id)

    const raced = await seedRepository({ projectPath: "acme/auto-manual-race" })
    await setAutomatic(raced, true)
    await closeGate(raced)
    const [automatic, manual] = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* Effect.all(
          [repair.considerAutomatic(raced.id), repair.startManual(raced.id)],
          { concurrency: "unbounded" },
        )
      }),
    )
    expect(automatic?.id).toBe(manual.id)
    expect((await invocationCount(raced.id)).repairs).toBe(1)
  })

  test("failure, timeout, restart, and an earlier manual attempt are not repeated automatically", async () => {
    const failed = await seedRepository({ projectPath: "acme/auto-failed" })
    await setAutomatic(failed, true)
    await closeGate(failed)
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.considerAutomatic(failed.id)
        yield* repair.drive(queued?.id ?? "")
        return yield* repair.latestForRepository(failed.id)
      }),
    )
    expect(first?.outcome).toBe("failed")
    expect(first?.requestSource).toBe("automatic")
    expect(control.prompts[0]).toContain("one automatic repository CI repair")
    await setAutomatic(failed, false)
    await setAutomatic(failed, true)
    expect(await consider(failed.id)).toBeNull()
    expect((await invocationCount(failed.id)).repairs).toBe(1)
    const retried = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(failed.id)
      }),
    )
    expect(retried.requestSource).toBe("manual")
    expect(retried.id).not.toBe(first?.id)

    const manualFirst = await seedRepository({
      projectPath: "acme/auto-after-manual",
    })
    await closeGate(manualFirst)
    await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.startManual(manualFirst.id)
        yield* repair.drive(queued.id)
      }),
    )
    await setAutomatic(manualFirst, true)
    expect(await consider(manualFirst.id)).toBeNull()
    expect((await invocationCount(manualFirst.id)).repairs).toBe(1)

    const timedOut = await seedRepository({ projectPath: "acme/auto-timeout" })
    await setAutomatic(timedOut, true)
    await closeGate(timedOut)
    control.mode = "block"
    const timed = await runtime.runPromise(
      Effect.gen(function* () {
        control.release = yield* Deferred.make<void>()
        control.entered = yield* Deferred.make<void>()
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.hours(5),
        })
        const queued = yield* repair.considerAutomatic(timedOut.id)
        const drive = yield* repair
          .drive(queued?.id ?? "")
          .pipe(Effect.forkChild)
        yield* Deferred.await(control.entered as Deferred.Deferred<void>)
        yield* TestClock.adjust(Duration.millis(CI_REPAIR_BUDGET_MS + 1000))
        yield* Fiber.join(drive)
        return yield* repair.latestForRepository(timedOut.id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(timed?.outcome).toBe("timed_out")
    expect(await consider(timedOut.id)).toBeNull()
    const timeoutRetry = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        return yield* repair.startManual(timedOut.id)
      }),
    )
    expect(timeoutRetry.status).toBe("queued")
    expect(timeoutRetry.requestSource).toBe("manual")
  })

  test("reopening while queued does not launch, and a later incident can", async () => {
    const repository = await seedRepository({ projectPath: "acme/auto-reopen" })
    await setAutomatic(repository, true)
    await closeGate(repository)
    const firstIncident = await openIncidentId(repository.id)
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repair = yield* makeRepositoryCiRepair({ autoDrive: false })
        const queued = yield* repair.considerAutomatic(repository.id)
        observe = () => Effect.succeed(successObservation())
        yield* observeRepositoryCiGate({ repository, origin: "operator" })
        yield* repair.drive(queued?.id ?? "")
        return yield* repair.latestForRepository(repository.id)
      }),
    )
    expect(control.prompts).toHaveLength(0)
    expect(outcome?.status).toBe("recovered")
    expect(outcome?.launchedAt).toBeNull()

    observe = () => Effect.succeed(failureObservation("200:1"))
    await runtime.runPromise(
      observeRepositoryCiGate({ repository, origin: "polling" }),
    )
    const nextIncident = await openIncidentId(repository.id)
    expect(nextIncident).not.toBeNull()
    expect(nextIncident).not.toBe(firstIncident)
    const next = await consider(repository.id)
    expect(next?.requestSource).toBe("automatic")
    expect(next?.incidentId).toBe(nextIncident)
    expect(next?.id).not.toBe(outcome?.id)
  })

  test("recovery during execution follows the gate observer", async () => {
    const repository = await seedRepository({
      projectPath: "acme/auto-recover",
    })
    await setAutomatic(repository, true)
    await closeGate(repository)
    control.mode = "block"
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        control.release = yield* Deferred.make<void>()
        control.entered = yield* Deferred.make<void>()
        const repair = yield* makeRepositoryCiRepair({
          autoDrive: false,
          pollInterval: Duration.seconds(1),
        })
        const queued = yield* repair.considerAutomatic(repository.id)
        const drive = yield* repair
          .drive(queued?.id ?? "")
          .pipe(Effect.forkChild)
        yield* Deferred.await(control.entered as Deferred.Deferred<void>)
        observe = () => Effect.succeed(successObservation("101:1"))
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(drive)
        return yield* repair.latestForRepository(repository.id)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(outcome?.outcome).toBe("recovered")
    expect(outcome?.requestSource).toBe("automatic")
    expect(control.kills.length).toBeGreaterThan(0)
  })

  test("restart reconciles an automatic attempt and does not launch another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-repair-auto-"))
    const filename = join(dir, "harness.sqlite")
    const firstRuntime = ManagedRuntime.make(
      makeRuntimeLayer(makeFileDatabaseTest(filename)),
    )
    let repositoryId = ""
    try {
      const repository = await seedRepository(
        { projectPath: "acme/auto-restart" },
        firstRuntime,
      )
      repositoryId = repository.id
      await setAutomatic(repository, true, firstRuntime)
      await closeGate(repository, firstRuntime)
      const queued = await consider(repository.id, firstRuntime)
      expect(queued?.requestSource).toBe("automatic")
      expect(queued?.status).toBe("queued")
    } finally {
      await firstRuntime.dispose()
    }
    const secondRuntime = ManagedRuntime.make(
      makeRuntimeLayer(makeFileDatabaseTest(filename)),
    )
    try {
      const result = await secondRuntime.runPromise(
        Effect.gen(function* () {
          const repair = yield* makeRepositoryCiRepair({
            autoDrive: false,
            epoch: "epoch-b",
          })
          yield* repair.reconcile()
          const again = yield* repair.considerAutomatic(repositoryId)
          const manual = yield* repair.startManual(repositoryId)
          return { again, manual }
        }),
      )
      expect(result.again).toBeNull()
      expect(result.manual.requestSource).toBe("manual")
      expect(result.manual.status).toBe("queued")
      expect((await invocationCount(repositoryId, secondRuntime)).repairs).toBe(
        2,
      )
    } finally {
      await secondRuntime.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("saving the GitHub opt-in enqueues the current Closed incident once", async () => {
    const graphqlRuntime = ManagedRuntime.make(
      RepositoryCiRepairLive({
        autoDrive: false,
        pollInterval: Duration.hours(5),
      }).pipe(Layer.provideMerge(runtimeLayer)),
    )
    try {
      const repository = await seedRepository(
        { projectPath: "acme/auto-save" },
        graphqlRuntime,
      )
      await closeGate(repository, graphqlRuntime)
      const saved = await createGraphqlApi(graphqlRuntime).fetch(
        graphqlRequest({
          query: `mutation Save($input: UpdateRepositorySettingsInput!) {
            updateRepositorySettings(input: $input) {
              automaticCiRepair
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
              mergePolicy: "CLASSIFY",
              includeAllIssueAuthors: false,
              waitForReadyForReviewChecks: true,
              automaticCiRepair: true,
            },
          },
        }),
      )
      const payload = (await saved.json()) as {
        data?: { updateRepositorySettings: { automaticCiRepair: boolean } }
        errors?: unknown
      }
      expect(payload.errors).toBeUndefined()
      expect(payload.data?.updateRepositorySettings.automaticCiRepair).toBe(
        true,
      )
      expect(
        (await invocationCount(repository.id, graphqlRuntime)).repairs,
      ).toBe(1)
      const again = await createGraphqlApi(graphqlRuntime).fetch(
        graphqlRequest({
          query: `mutation Save($input: UpdateRepositorySettingsInput!) {
            updateRepositorySettings(input: $input) { automaticCiRepair }
          }`,
          variables: {
            input: {
              repositoryId: repository.id,
              paused: false,
              defaultModel: null,
              defaultThinkingLevel: null,
              reviewModel: null,
              reviewThinkingLevel: null,
              mergePolicy: "CLASSIFY",
              includeAllIssueAuthors: false,
              waitForReadyForReviewChecks: true,
              automaticCiRepair: false,
            },
          },
        }),
      )
      expect(
        ((await again.json()) as { errors?: unknown }).errors,
      ).toBeUndefined()
      await createGraphqlApi(graphqlRuntime).fetch(
        graphqlRequest({
          query: `mutation Save($input: UpdateRepositorySettingsInput!) {
            updateRepositorySettings(input: $input) { automaticCiRepair }
          }`,
          variables: {
            input: {
              repositoryId: repository.id,
              paused: false,
              defaultModel: null,
              defaultThinkingLevel: null,
              reviewModel: null,
              reviewThinkingLevel: null,
              mergePolicy: "CLASSIFY",
              includeAllIssueAuthors: false,
              waitForReadyForReviewChecks: true,
              automaticCiRepair: true,
            },
          },
        }),
      )
      expect(
        (await invocationCount(repository.id, graphqlRuntime)).repairs,
      ).toBe(1)
    } finally {
      await graphqlRuntime.dispose()
    }
  })
})
