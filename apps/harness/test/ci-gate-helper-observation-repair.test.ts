import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { ciGateRunOrderKey } from "@ready-for-agent/forge-contract"
import {
  type GitHubService,
  githubHelperSuccess,
  serializeGitHubHelperControl,
} from "@ready-for-agent/github-service"
import type { GitLabService } from "@ready-for-agent/gitlab-service"
import { observeRepositoryCiGate } from "@ready-for-agent/graphql-api"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "@ready-for-agent/work-item-lifecycle"
import { SerializedCiGateObservation } from "../src/server/forge-helper-schemas.js"
import { GitHubOperationCoordinatorLive } from "../src/server/github-operation-coordinator.js"
import { keymaxxerGitHubLayer } from "../src/server/keymaxxer-github-layer.js"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

setDefaultTimeout(30_000)

/**
 * Confirmed incident: processfocus/monorepo, 2026-10-20. The previous repair
 * left a keyless suppress of this run. A newer trunk failure must be able to
 * start automatic CI Repair without a database edit.
 */
const SUPPRESSED_RUN_IDENTITY = "39226690563:1"
const NEWER_RUN_IDENTITY = "39357507624:1"
const LATER_RUN_IDENTITY = "39357507625:1"
const DEFINITION_IDENTITY = "161335"
const NEWER_ORDER_KEY = ciGateRunOrderKey(39357507624, 1)
const SUPPRESSED_ORDER_KEY = ciGateRunOrderKey(39226690563, 1)
const LATER_ORDER_KEY = ciGateRunOrderKey(39357507625, 1)

const successfulHelperControl = serializeGitHubHelperControl(
  githubHelperSuccess(),
)

const idleSteps: LifecycleStepsShape = {
  createWorktree: () => Effect.die("unused"),
  installDependencies: () => Effect.die("unused"),
  implement: () => Effect.die("unused"),
  assessChanges: () => Effect.die("unused"),
  preCommit: () => Effect.die("unused"),
  review: () => Effect.die("unused"),
  commit: () => Effect.die("unused"),
  createPr: () => Effect.die("unused"),
  watchPrStatusChecks: () => Effect.die("unused"),
  resolvePrMergeConflict: () => Effect.die("unused"),
  investigatePrStatusChecks: () => Effect.die("unused"),
  markPrReadyForReview: () => Effect.die("unused"),
  decidePrMerge: () => Effect.die("unused"),
  mergePr: () => Effect.die("unused"),
  closeIssue: () => Effect.die("unused"),
  localCleanup: () => Effect.die("unused"),
  removeWorktree: () => Effect.die("unused"),
}

const property = (value: object, key: string): unknown =>
  Object.entries(value).find(([entryKey]) => entryKey === key)?.[1]

const decodeHelperObservation = (stdout: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SerializedCiGateObservation))(
    stdout,
  )

const helperStdout = (run: {
  readonly runIdentity: string
  readonly rawStatus: string
  readonly rawConclusion: string | null
  readonly orderKey?: string
  readonly earlyJobFailure?: boolean
}): string =>
  JSON.stringify({
    defaultBranch: "trunk",
    observations: [
      {
        identity: DEFINITION_IDENTITY,
        kind: "observed",
        runs: [
          {
            runIdentity: run.runIdentity,
            htmlUrl: `https://github.com/processfocus/monorepo/actions/runs/${run.runIdentity.split(":")[0]}`,
            headSha: `sha-${run.runIdentity}`,
            headRef: "trunk",
            event: "push",
            createdAt: "2026-10-20T12:00:00.000Z",
            updatedAt: "2026-10-20T12:05:00.000Z",
            startedAt: "2026-10-20T12:00:01.000Z",
            rawStatus: run.rawStatus,
            rawConclusion: run.rawConclusion,
            ...(run.orderKey === undefined ? {} : { orderKey: run.orderKey }),
            ...(run.earlyJobFailure === undefined
              ? {}
              : { earlyJobFailure: run.earlyJobFailure }),
          },
        ],
      },
    ],
  })

const observedRun = (stdout: string) => {
  const decoded = decodeHelperObservation(stdout)
  const observation = decoded.observations[0]
  if (observation === undefined || observation.kind !== "observed") {
    throw new Error("helper observation did not decode an observed run")
  }
  const run = observation.runs[0]
  if (run === undefined) {
    throw new Error("helper observation did not decode a run")
  }
  return run
}

describe("helper CI Gate observation decoding", () => {
  test("keeps run order and early job failure from helper JSON", () => {
    const run = observedRun(
      helperStdout({
        runIdentity: NEWER_RUN_IDENTITY,
        rawStatus: "in_progress",
        rawConclusion: null,
        orderKey: NEWER_ORDER_KEY,
        earlyJobFailure: true,
      }),
    )
    expect(property(run, "orderKey")).toBe(NEWER_ORDER_KEY)
    expect(property(run, "earlyJobFailure")).toBe(true)
  })

  test("accepts a helper observation that omits optional run evidence", () => {
    const run = observedRun(
      helperStdout({
        runIdentity: NEWER_RUN_IDENTITY,
        rawStatus: "completed",
        rawConclusion: "failure",
      }),
    )
    expect(property(run, "orderKey")).toBeUndefined()
    expect(property(run, "earlyJobFailure")).toBeUndefined()
    expect(run.runIdentity).toBe(NEWER_RUN_IDENTITY)
    expect(run.rawConclusion).toBe("failure")
  })
})

const githubFromHelper = (readStdout: () => string) =>
  keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
    Layer.provide(GitHubOperationCoordinatorLive),
    Layer.provide(
      Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_PROCESSFOCUS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () =>
          Effect.succeed({
            exitCode: 0,
            stdout: readStdout(),
            stderr: successfulHelperControl,
          }),
      }),
    ),
  )

const runtimeLayer = (readStdout: () => string) => {
  const github = githubFromHelper(readStdout)
  return Layer.mergeAll(
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
      Layer.provideMerge(github),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
      Layer.provideMerge(stubLinearServiceLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(idleSteps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    ),
    github,
    DbServiceLive.pipe(Layer.provideMerge(DatabaseTest)),
  )
}

const seedRepository = (input: {
  readonly label: string
  readonly paused: boolean
  readonly automaticCiRepair: boolean
  readonly keylessSuppress: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const config = yield* db.getConfig
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: config.defaultModel ?? "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
      reviewModel: config.reviewModel,
      reviewThinkingLevel: config.reviewThinkingLevel,
      maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
      maxConcurrentWorkItems: config.maxConcurrentWorkItems,
    })
    const repository = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: `processfocus/monorepo-${input.label}`,
      localPath: `/repos/processfocus/monorepo-${input.label}.git`,
      isBare: true,
    })
    yield* db.updateRepositorySettings({
      repositoryId: repository.id,
      paused: input.paused,
      defaultModel: null,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      mergePolicy: repository.mergePolicy,
      includeAllIssueAuthors: repository.includeAllIssueAuthors,
      waitForReadyForReviewChecks: repository.waitForReadyForReviewChecks,
      automaticCiRepair: input.automaticCiRepair,
      selectedCiGateDefinitions: [
        {
          identity: DEFINITION_IDENTITY,
          displayLabel: "CI",
          kind: "workflow",
          diagnosticMetadata: ".github/workflows/ci.yml",
        },
      ],
    })
    if (input.keylessSuppress) {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        `INSERT INTO ci_repair_baseline (
           repository_id, definition_identity, run_identity, order_key,
           head_sha, inclusive, floor_order_key,
           suppress_through_run_identity, suppress_through_order_key, updated_at
         ) VALUES (?, ?, ?, NULL, NULL, 0, NULL, ?, NULL, ?)`,
        [
          repository.id,
          DEFINITION_IDENTITY,
          SUPPRESSED_RUN_IDENTITY,
          SUPPRESSED_RUN_IDENTITY,
          Date.now(),
        ],
      )
    }
    const refreshed = (yield* db.listRepositories).find(
      (entry) => entry.id === repository.id,
    )
    if (refreshed === undefined) {
      throw new Error(`Missing repository ${repository.id}`)
    }
    return refreshed
  })

const observe = (repositoryId: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repository = (yield* db.listRepositories).find(
      (entry) => entry.id === repositoryId,
    )
    if (repository === undefined) {
      throw new Error(`Missing repository ${repositoryId}`)
    }
    yield* observeRepositoryCiGate({ repository, origin: "polling" })
  })

const repairsFor = (repositoryId: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const workItems = yield* lifecycle.listWorkItemsForRepository(repositoryId)
    return workItems.filter((workItem) => workItem.origin === "ci_repair")
  })

const storedObservation = (repositoryId: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const snapshot = yield* db.loadCiGateSnapshot(repositoryId)
    return snapshot.observations[0]
  })

const run = (
  readStdout: () => string,
  effect: Effect.Effect<
    void,
    unknown,
    | SqlClient.SqlClient
    | DbService
    | WorkItemLifecycle
    | GitHubService
    | GitLabService
    | AzureDevOpsService
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer(readStdout))))

describe("helper observation to automatic CI Repair", () => {
  test("starts one repair for a newer failure after a keyless baseline", async () => {
    const stdout = helperStdout({
      runIdentity: NEWER_RUN_IDENTITY,
      rawStatus: "completed",
      rawConclusion: "failure",
      orderKey: NEWER_ORDER_KEY,
    })
    await run(
      () => stdout,
      Effect.gen(function* () {
        const repository = yield* seedRepository({
          label: "newer-failure",
          paused: false,
          automaticCiRepair: true,
          keylessSuppress: true,
        })
        yield* observe(repository.id)
        const stored = yield* storedObservation(repository.id)
        expect(stored?.lastRunOrderKey).toBe(NEWER_ORDER_KEY)
        expect(stored?.latchedRunOrderKey).toBe(NEWER_ORDER_KEY)
        expect(stored?.failureLatched).toBe(true)
        const started = yield* repairsFor(repository.id)
        expect(started).toHaveLength(1)
        expect(started[0]?.ciRepairFailingRuns[0]?.runIdentity).toBe(
          NEWER_RUN_IDENTITY,
        )
        expect(started[0]?.ciRepairFailingRuns[0]?.orderKey).toBe(
          NEWER_ORDER_KEY,
        )
        yield* observe(repository.id)
        expect(yield* repairsFor(repository.id)).toHaveLength(1)
      }),
    )
  })

  test("does not restart repair for the exact suppressed run", async () => {
    const stdout = helperStdout({
      runIdentity: SUPPRESSED_RUN_IDENTITY,
      rawStatus: "completed",
      rawConclusion: "failure",
      orderKey: SUPPRESSED_ORDER_KEY,
    })
    await run(
      () => stdout,
      Effect.gen(function* () {
        const repository = yield* seedRepository({
          label: "suppressed-run",
          paused: false,
          automaticCiRepair: true,
          keylessSuppress: true,
        })
        yield* observe(repository.id)
        const stored = yield* storedObservation(repository.id)
        expect(stored?.latchedRunOrderKey).toBe(SUPPRESSED_ORDER_KEY)
        expect(yield* repairsFor(repository.id)).toHaveLength(0)
      }),
    )
  })

  test("starts repair from a still-running workflow once a job has failed", async () => {
    const stdout = helperStdout({
      runIdentity: NEWER_RUN_IDENTITY,
      rawStatus: "in_progress",
      rawConclusion: null,
      orderKey: NEWER_ORDER_KEY,
      earlyJobFailure: true,
    })
    await run(
      () => stdout,
      Effect.gen(function* () {
        const repository = yield* seedRepository({
          label: "early-job",
          paused: false,
          automaticCiRepair: true,
          keylessSuppress: true,
        })
        yield* observe(repository.id)
        const stored = yield* storedObservation(repository.id)
        expect(stored?.lastEarlyJobFailure).toBe(true)
        expect(stored?.latchedRunOrderKey).toBe(NEWER_ORDER_KEY)
        const started = yield* repairsFor(repository.id)
        expect(started).toHaveLength(1)
        expect(started[0]?.ciRepairFailingRuns[0]?.runIdentity).toBe(
          NEWER_RUN_IDENTITY,
        )
      }),
    )
  })

  test("does not start repair while the repository is paused", async () => {
    const stdout = helperStdout({
      runIdentity: NEWER_RUN_IDENTITY,
      rawStatus: "completed",
      rawConclusion: "failure",
      orderKey: NEWER_ORDER_KEY,
    })
    await run(
      () => stdout,
      Effect.gen(function* () {
        const repository = yield* seedRepository({
          label: "paused",
          paused: true,
          automaticCiRepair: true,
          keylessSuppress: true,
        })
        yield* observe(repository.id)
        const stored = yield* storedObservation(repository.id)
        expect(stored?.latchedRunOrderKey).toBe(NEWER_ORDER_KEY)
        expect(yield* repairsFor(repository.id)).toHaveLength(0)
      }),
    )
  })

  test("does not start a second repair while one is unfinished", async () => {
    let stdout = helperStdout({
      runIdentity: NEWER_RUN_IDENTITY,
      rawStatus: "completed",
      rawConclusion: "failure",
      orderKey: NEWER_ORDER_KEY,
    })
    await run(
      () => stdout,
      Effect.gen(function* () {
        const repository = yield* seedRepository({
          label: "unfinished",
          paused: false,
          automaticCiRepair: true,
          keylessSuppress: true,
        })
        yield* observe(repository.id)
        const started = yield* repairsFor(repository.id)
        expect(started).toHaveLength(1)
        stdout = helperStdout({
          runIdentity: LATER_RUN_IDENTITY,
          rawStatus: "completed",
          rawConclusion: "failure",
          orderKey: LATER_ORDER_KEY,
        })
        yield* observe(repository.id)
        const stillOne = yield* repairsFor(repository.id)
        expect(stillOne).toHaveLength(1)
        expect(stillOne[0]?.id).toBe(started[0]?.id)
        expect(stillOne[0]?.ciRepairFailingRuns[0]?.runIdentity).toBe(
          NEWER_RUN_IDENTITY,
        )
      }),
    )
  })
})
