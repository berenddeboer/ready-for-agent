import "@tanstack/react-start/server-only"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import {
  Effect,
  type FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  type Path,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  AgentBackend,
  type AgentBackendId,
  type ResolveAgentBackendRuntime,
  SessionTelemetryProvider,
  isSelectableAgentBackendId,
  resolveActiveRegistration,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"
import { DatabaseLive } from "@ready-for-agent/db"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import { Grok } from "@ready-for-agent/grok"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  disabledKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import {
  Opencode,
  OpencodeSessionTelemetryLive,
} from "@ready-for-agent/opencode"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleStepsLive,
  WorkItemLifecycleLive,
} from "@ready-for-agent/work-item-lifecycle"
import type { ApplicationRequestContext } from "../application-request-context.js"
import { ambientGitHubLayer } from "./ambient-github-layer.js"
import {
  environmentConfigLayer,
  loadApplicationConfig,
} from "./application-config.js"
import { JobWorkerLive } from "./job-worker.js"
import { keymaxxerGitHubLayer } from "./keymaxxer-github-layer.js"

export interface Application {
  readonly context: ApplicationRequestContext
  readonly dispose: () => Promise<void>
}

export interface CreateApplicationOptions {
  readonly startWorker?: boolean
}

type PlatformServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

const makeResolveRuntime = (
  platformLayer: Layer.Layer<PlatformServices>,
  sidecarUrl: string | undefined,
): ResolveAgentBackendRuntime => {
  return (backendId: AgentBackendId) => {
    const registration = resolveActiveRegistration(backendId)

    if (registration.descriptor.id === AGENT_BACKEND_IDS.grok) {
      return Effect.gen(function* () {
        const adapter = yield* AgentBackend
        return {
          registration,
          adapter,
          telemetry: {
            getSession: (sessionId: string) =>
              Effect.succeed(
                unsupportedSessionTelemetry(sessionId, registration.descriptor),
              ),
          },
        }
      }).pipe(Effect.provide(Grok.layer().pipe(Layer.provide(platformLayer))))
    }

    return Effect.gen(function* () {
      const adapter = yield* AgentBackend
      const telemetry = yield* SessionTelemetryProvider
      return {
        registration,
        adapter,
        telemetry,
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Opencode.layer({
            ...(sidecarUrl === undefined
              ? {}
              : { keymaxxerMcpUrl: sidecarUrl }),
          }).pipe(Layer.provide(platformLayer)),
          OpencodeSessionTelemetryLive(),
        ),
      ),
    )
  }
}

export const createApplication = async (
  environment: Partial<Record<string, string | undefined>> = process.env,
  options: CreateApplicationOptions = {},
): Promise<Application> => {
  const configLayer = environmentConfigLayer(environment)
  const config = await Effect.runPromise(loadApplicationConfig(environment))
  const sidecarUrl = config.keymaxxerSidecarUrl
  const databaseLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseLive))
  const keymaxxerLayer =
    sidecarUrl === undefined
      ? disabledKeymaxxerLayer
      : sidecarKeymaxxerLayer(sidecarUrl)
  const toolCwd = config.hostToolCwd
  const platformLayer = BunChildProcessSpawner.layer.pipe(
    Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  )
  const githubLayer =
    sidecarUrl === undefined
      ? ambientGitHubLayer({ workspaceRoot: toolCwd }).pipe(
          Layer.provide(platformLayer),
        )
      : keymaxxerGitHubLayer({ workspaceRoot: toolCwd }).pipe(
          Layer.provide(keymaxxerLayer),
        )
  const reconcilerLayer = IssueReconcilerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(githubLayer),
  )
  const queueLayer = SqliteQueueServiceLive.pipe(
    Layer.provideMerge(databaseLayer),
  )

  // Seed Active with the full selected-or-in-use set (harness default ∪
  // repository overrides ∪ unfinished Work Item captures). Also pass Config's
  // selected backend as selectedBackendId so the process-wide proxy follows
  // the harness default even when other backends are also Active.
  // GraphQL Save paths re-sync via setSelectedOrInUse after settings changes.
  const bootBackends = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService
      const [config, selectedOrInUse] = yield* Effect.all([
        db.getConfig,
        db.listSelectedOrInUseBackendIds,
      ])
      return {
        selectedAgentBackend: config.selectedAgentBackend,
        selectedOrInUse,
      }
    }).pipe(Effect.provide(databaseLayer)),
  )
    .then(({ selectedAgentBackend, selectedOrInUse }) => {
      const selectable = selectedOrInUse.filter((id): id is AgentBackendId =>
        isSelectableAgentBackendId(id),
      )
      const selectedBackendId = isSelectableAgentBackendId(selectedAgentBackend)
        ? (selectedAgentBackend as AgentBackendId)
        : AGENT_BACKEND_IDS.opencode
      return {
        selectedBackendId,
        initialBackendIds:
          selectable.length > 0
            ? selectable
            : ([selectedBackendId] as AgentBackendId[]),
      }
    })
    .catch(() => ({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      initialBackendIds: [AGENT_BACKEND_IDS.opencode] as AgentBackendId[],
    }))

  const resolveRuntime = makeResolveRuntime(platformLayer, sidecarUrl)
  const activeLayer = ActiveAgentBackendLive({
    initialBackendIds: bootBackends.initialBackendIds,
    selectedBackendId: bootBackends.selectedBackendId,
    resolveRuntime,
  })

  const lifecycleLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(LifecycleStepsLive),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(activeLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(githubLayer),
    Layer.provide(platformLayer),
  )
  const workerLayer = JobWorkerLive.pipe(
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(reconcilerLayer),
    Layer.provideMerge(lifecycleLayer),
    Layer.provideMerge(keymaxxerLayer),
  )
  const loggingLayer = Logger.layer([Logger.consolePretty({ colors: false })])
  const applicationServices =
    options.startWorker === false
      ? Layer.mergeAll(
          reconcilerLayer,
          queueLayer,
          keymaxxerLayer,
          activeLayer,
          lifecycleLayer,
          loggingLayer,
        )
      : Layer.mergeAll(
          reconcilerLayer,
          workerLayer,
          queueLayer,
          keymaxxerLayer,
          activeLayer,
          lifecycleLayer,
          loggingLayer,
        )
  const appLayer = applicationServices.pipe(Layer.provide(configLayer))
  const runtime = ManagedRuntime.make(appLayer)

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
        // Startup inspection: failure must not terminate the Harness.
        const active = yield* ActiveAgentBackend
        // Startup inspect for every initial Active backend (selected-or-in-use).
        const statuses = yield* active.listStatuses
        for (const status of statuses) {
          yield* active.recheck(status.backend.id, {
            cwd: toolCwd,
            timeout: "30 seconds",
          })
        }
      }),
    )
  } catch (error) {
    await runtime.dispose()
    throw error
  }

  return {
    context: {
      graphqlApi: createGraphqlApi(runtime, { agentBackendCwd: toolCwd }),
    },
    dispose: runtime.dispose,
  }
}
