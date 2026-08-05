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
} from "@ready-for-agent/agent-backend"
import { Claude, ClaudeSessionTelemetryLive } from "@ready-for-agent/claude"
import { Codex, CodexSessionTelemetryLive } from "@ready-for-agent/codex"
import { DatabaseLive } from "@ready-for-agent/db"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import { Grok, GrokSessionTelemetryLive } from "@ready-for-agent/grok"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  type SidecarLayerOptions,
  disabledKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
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
import { ambientGitLabLayer } from "./ambient-gitlab-layer.js"
import {
  environmentConfigLayer,
  loadApplicationConfig,
} from "./application-config.js"
import { JobWorkerLive } from "./job-worker.js"
import { keymaxxerGitHubLayer } from "./keymaxxer-github-layer.js"
import { keymaxxerGitLabLayer } from "./keymaxxer-gitlab-layer.js"

export interface Application {
  readonly context: ApplicationRequestContext
  readonly dispose: () => Promise<void>
}

export interface CreateApplicationOptions {
  readonly startWorker?: boolean
  readonly sidecarLayerOptions?: SidecarLayerOptions
}

type PlatformServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

const makeResolveRuntime = (
  platformLayer: Layer.Layer<PlatformServices>,
  sidecarUrl: string | undefined,
): ResolveAgentBackendRuntime => {
  const backendLayers = (backendId: AgentBackendId) => {
    if (backendId === AGENT_BACKEND_IDS.grok) {
      return Layer.mergeAll(
        Grok.layer().pipe(Layer.provide(platformLayer)),
        GrokSessionTelemetryLive(),
      )
    }
    if (backendId === AGENT_BACKEND_IDS.codex) {
      return Layer.mergeAll(
        Codex.layer().pipe(Layer.provide(platformLayer)),
        CodexSessionTelemetryLive(),
      )
    }
    if (backendId === AGENT_BACKEND_IDS.claude) {
      return Layer.mergeAll(
        Claude.layer().pipe(Layer.provide(platformLayer)),
        ClaudeSessionTelemetryLive(),
      )
    }
    return Layer.mergeAll(
      Opencode.layer({
        ...(sidecarUrl === undefined ? {} : { keymaxxerMcpUrl: sidecarUrl }),
      }).pipe(Layer.provide(platformLayer)),
      OpencodeSessionTelemetryLive(),
    )
  }

  return (backendId: AgentBackendId) => {
    const registration = resolveActiveRegistration(backendId)
    return Effect.gen(function* () {
      const adapter = yield* AgentBackend
      const telemetry = yield* SessionTelemetryProvider
      return {
        registration,
        adapter,
        telemetry,
      }
    }).pipe(Effect.provide(backendLayers(registration.descriptor.id)))
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
      : sidecarKeymaxxerLayer(sidecarUrl, options.sidecarLayerOptions)
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
  const gitlabLayer =
    sidecarUrl === undefined
      ? ambientGitLabLayer({
          workspaceRoot: toolCwd,
          environment,
        }).pipe(Layer.provide(platformLayer))
      : keymaxxerGitLabLayer({
          workspaceRoot: toolCwd,
          environment,
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))
  const reconcilerLayer = IssueReconcilerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(githubLayer),
    Layer.provideMerge(gitlabLayer),
  )
  const queueLayer = SqliteQueueServiceLive.pipe(
    Layer.provideMerge(databaseLayer),
  )

  // Seed Active with the full selected-or-in-use set (harness default ∪
  // repository overrides ∪ unfinished Work Item captures). Also pass Config's
  // selected backend as selectedBackendId so the process-wide proxy follows
  // the harness default even when other backends are also Active.
  // GraphQL Save paths re-sync via setSelectedOrInUse after settings changes.
  //
  // Boot read lives in the layer graph (not a pre-runtime Effect.runPromise)
  // so it shares ManagedRuntime's databaseLayer memoization. Typed recovery
  // (orElseSucceed) falls back on expected DB errors only; defects stay
  // visible. Seeding failure must not prevent startup.
  const resolveRuntime = makeResolveRuntime(platformLayer, sidecarUrl)
  const defaultActiveBackendSeed = {
    selectedBackendId: AGENT_BACKEND_IDS.opencode,
    initialBackendIds: [
      AGENT_BACKEND_IDS.opencode,
    ] as ReadonlyArray<AgentBackendId>,
  }
  const activeLayer = Layer.unwrap(
    Effect.gen(function* () {
      const db = yield* DbService
      const boot = yield* Effect.gen(function* () {
        const [config, selectedOrInUse] = yield* Effect.all([
          db.getConfig,
          db.listSelectedOrInUseBackendIds,
        ])
        const selectable = selectedOrInUse.filter((id): id is AgentBackendId =>
          isSelectableAgentBackendId(id),
        )
        const selectedBackendId = isSelectableAgentBackendId(
          config.selectedAgentBackend,
        )
          ? config.selectedAgentBackend
          : AGENT_BACKEND_IDS.opencode
        return {
          selectedBackendId,
          initialBackendIds:
            selectable.length > 0 ? selectable : [selectedBackendId],
        }
      }).pipe(Effect.orElseSucceed(() => defaultActiveBackendSeed))

      return ActiveAgentBackendLive({
        initialBackendIds: boot.initialBackendIds,
        selectedBackendId: boot.selectedBackendId,
        resolveRuntime,
      })
    }),
  ).pipe(Layer.provide(databaseLayer))

  const lifecycleLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(LifecycleStepsLive),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(activeLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(githubLayer),
    Layer.provideMerge(gitlabLayer),
    Layer.provide(platformLayer),
  )
  const workerLayer = JobWorkerLive.pipe(
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(reconcilerLayer),
    Layer.provideMerge(lifecycleLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(gitlabLayer),
  )
  const loggingLayer = Logger.layer([Logger.consolePretty({ colors: false })])
  const localGitLayer = LocalGit.layer.pipe(Layer.provide(platformLayer))
  const directoryPickerLayer = DirectoryPicker.layer().pipe(
    Layer.provide(platformLayer),
  )
  const applicationServices =
    options.startWorker === false
      ? Layer.mergeAll(
          reconcilerLayer,
          queueLayer,
          keymaxxerLayer,
          gitlabLayer,
          activeLayer,
          lifecycleLayer,
          localGitLayer,
          directoryPickerLayer,
          loggingLayer,
        )
      : Layer.mergeAll(
          reconcilerLayer,
          workerLayer,
          queueLayer,
          keymaxxerLayer,
          gitlabLayer,
          activeLayer,
          lifecycleLayer,
          localGitLayer,
          directoryPickerLayer,
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
