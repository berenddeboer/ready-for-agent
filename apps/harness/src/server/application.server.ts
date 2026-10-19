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
import type { ChildProcessSpawner } from "effect/process"
import {
  AGENT_BACKEND_IDS,
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
  OWNED_OPENCODE_SERVER_MISSING_MESSAGE,
  Opencode,
  OpencodeSessionTelemetryLive,
  type OwnedOpenCodeServer,
  blockedOpenCodeSessionConnect,
  keymaxxerRequiresOwnedOpenCodeServer,
  makeOpenCodeServerBaseResolver,
  openCodeSessionWebUrl,
  selectHarnessOpenCodeConnection,
  startOwnedOpenCodeServer,
} from "@ready-for-agent/opencode"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleStepsLive,
  SharedAgentTurnAdmissionLive,
  makeWorkItemLifecycleLive,
} from "@ready-for-agent/work-item-lifecycle"
import type { ApplicationRequestContext } from "../application-request-context.js"
import { READY_FOR_AGENT_VERSION } from "../generated/version.js"
import { ambientAzureDevOpsLayer } from "./ambient-azure-devops-layer.js"
import { ambientGitHubLayer } from "./ambient-github-layer.js"
import { ambientGitLabLayer } from "./ambient-gitlab-layer.js"
import { ambientLinearLayer } from "./ambient-linear-layer.js"
import {
  environmentConfigLayer,
  loadApplicationConfig,
} from "./application-config.js"
import { GitHubOperationCoordinatorLive } from "./github-operation-coordinator.js"
import { JobWorkerLive } from "./job-worker.js"
import { keymaxxerAzureDevOpsLayer } from "./keymaxxer-azure-devops-layer.js"
import { keymaxxerGitHubLayer } from "./keymaxxer-github-layer.js"
import { keymaxxerGitLabLayer } from "./keymaxxer-gitlab-layer.js"
import { keymaxxerLinearLayer } from "./keymaxxer-linear-layer.js"
import { inspectBackendsAtStartup } from "./startup-backend-inspection.js"

export interface Application {
  readonly context: ApplicationRequestContext
  readonly dispose: () => Promise<void>
}

export interface CreateApplicationOptions {
  readonly startWorker?: boolean
  readonly sidecarLayerOptions?: SidecarLayerOptions
  /**
   * Explicit OpenCode server. When set, agent turns, telemetry reads, and
   * Open in OpenCode use this address instead of `opencode service status`.
   * Ignored while Keymaxxer is enabled: that mode uses the harness-owned server.
   */
  readonly openCodeServerBaseUrl?: string
  /**
   * Test seam for the harness-owned OpenCode server. Production uses
   * `startOwnedOpenCodeServer`.
   */
  readonly startOwnedOpenCodeServer?: typeof startOwnedOpenCodeServer
}

type PlatformServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

type OpenCodeRuntimeConnection =
  | {
      readonly kind: "dedicated"
      readonly server: {
        readonly baseUrl: string
        readonly password: string
        readonly headers: Readonly<Record<string, string>>
        readonly assertAvailable: () => string | undefined
      }
    }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "explicit"; readonly baseUrl: string }
  | { readonly kind: "default" }

const toOpenCodeRuntimeConnection = (
  connection: ReturnType<typeof selectHarnessOpenCodeConnection>,
  owned: OwnedOpenCodeServer | undefined,
): OpenCodeRuntimeConnection => {
  if (connection.kind !== "dedicated") return connection
  if (owned === undefined) {
    return {
      kind: "blocked",
      message: OWNED_OPENCODE_SERVER_MISSING_MESSAGE,
    }
  }
  return {
    kind: "dedicated",
    server: {
      baseUrl: owned.baseUrl,
      password: owned.password,
      headers: owned.headers,
      assertAvailable: owned.assertAvailable,
    },
  }
}

const openCodeExplicitServer = (
  serverBaseUrl: string | undefined,
): { readonly baseUrl: string } | undefined => {
  const trimmed = serverBaseUrl?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  return { baseUrl: trimmed }
}

const makeResolveRuntime = (
  platformLayer: Layer.Layer<PlatformServices>,
  sidecarUrl: string | undefined,
  openCode: OpenCodeRuntimeConnection,
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
    const dedicated =
      openCode.kind === "dedicated" ? openCode.server : undefined
    const explicit =
      openCode.kind === "explicit" ? { baseUrl: openCode.baseUrl } : undefined
    return Layer.mergeAll(
      Opencode.layer({
        ...(sidecarUrl === undefined ? {} : { keymaxxerMcpUrl: sidecarUrl }),
        ...(dedicated === undefined ? {} : { dedicatedServer: dedicated }),
        ...(explicit === undefined ? {} : { server: explicit }),
        ...(openCode.kind === "blocked"
          ? { openCodeBlockedReason: openCode.message }
          : {}),
      }).pipe(Layer.provide(platformLayer)),
      OpencodeSessionTelemetryLive(
        dedicated !== undefined
          ? {
              server: {
                baseUrl: dedicated.baseUrl,
                headers: dedicated.headers,
              },
            }
          : openCode.kind === "blocked"
            ? { connect: blockedOpenCodeSessionConnect(openCode.message) }
            : explicit === undefined
              ? {}
              : { server: explicit },
      ),
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
  const githubOperationCoordinatorLayer = GitHubOperationCoordinatorLive
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
  const azureDevOpsLayer =
    sidecarUrl === undefined
      ? ambientAzureDevOpsLayer({ environment })
      : keymaxxerAzureDevOpsLayer({
          workspaceRoot: toolCwd,
          environment,
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))
  const linearLayer =
    sidecarUrl === undefined
      ? ambientLinearLayer({ environment })
      : keymaxxerLinearLayer({
          workspaceRoot: toolCwd,
          environment,
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))
  const reconcilerLayer = IssueReconcilerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(githubLayer),
    Layer.provideMerge(gitlabLayer),
    Layer.provideMerge(azureDevOpsLayer),
    Layer.provideMerge(linearLayer),
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
  const openCodeServer = openCodeExplicitServer(options.openCodeServerBaseUrl)
  let ownedOpenCodeServer: OwnedOpenCodeServer | undefined
  let ownedOpenCodeStartupFailure: string | undefined
  if (keymaxxerRequiresOwnedOpenCodeServer(sidecarUrl)) {
    try {
      ownedOpenCodeServer = await (
        options.startOwnedOpenCodeServer ?? startOwnedOpenCodeServer
      )({
        keymaxxerMcpUrl: sidecarUrl,
      })
    } catch (error) {
      ownedOpenCodeStartupFailure =
        error instanceof Error
          ? error.message
          : "The harness-owned OpenCode server failed to start."
    }
  }
  const openCodeConnection = toOpenCodeRuntimeConnection(
    selectHarnessOpenCodeConnection({
      ...(sidecarUrl === undefined ? {} : { keymaxxerMcpUrl: sidecarUrl }),
      ...(ownedOpenCodeServer === undefined
        ? {}
        : { ownedBaseUrl: ownedOpenCodeServer.baseUrl }),
      ...(openCodeServer === undefined
        ? {}
        : { explicitBaseUrl: openCodeServer.baseUrl }),
      ...(ownedOpenCodeStartupFailure === undefined
        ? {}
        : { startupFailure: ownedOpenCodeStartupFailure }),
    }),
    ownedOpenCodeServer,
  )
  const resolveRuntime = makeResolveRuntime(
    platformLayer,
    sidecarUrl,
    openCodeConnection,
  )
  const resolveOpenCodeServerBase = makeOpenCodeServerBaseResolver(
    openCodeConnection.kind === "dedicated"
      ? { explicitServerBase: openCodeConnection.server.baseUrl }
      : openCodeConnection.kind === "explicit"
        ? { explicitServerBase: openCodeConnection.baseUrl }
        : openCodeConnection.kind === "blocked"
          ? {
              // Do not discover the shared service for a session the owned
              // server never created.
              serviceStatus: () =>
                Promise.reject(new Error("owned server unavailable")),
            }
          : {},
  )
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

  // One admission gate for lifecycle turns, including CI Repair Work Items.
  const admissionLayer = SharedAgentTurnAdmissionLive.pipe(
    Layer.provideMerge(databaseLayer),
  )
  const lifecycleLayer = makeWorkItemLifecycleLive({
    inspectCwd: toolCwd,
  }).pipe(
    Layer.provideMerge(LifecycleStepsLive),
    Layer.provideMerge(admissionLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(activeLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(githubLayer),
    Layer.provideMerge(gitlabLayer),
    Layer.provideMerge(azureDevOpsLayer),
    Layer.provideMerge(linearLayer),
    Layer.provide(platformLayer),
  )
  const workerLayer = JobWorkerLive.pipe(
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(reconcilerLayer),
    Layer.provideMerge(lifecycleLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(gitlabLayer),
    Layer.provideMerge(azureDevOpsLayer),
    Layer.provideMerge(linearLayer),
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
          linearLayer,
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
          linearLayer,
          activeLayer,
          lifecycleLayer,
          localGitLayer,
          directoryPickerLayer,
          loggingLayer,
        )
  const appLayer = applicationServices.pipe(
    Layer.provide(configLayer),
    Layer.provideMerge(githubOperationCoordinatorLayer),
  )
  const runtime = await Promise.resolve()
    .then(() => ManagedRuntime.make(appLayer))
    .catch(async (error: unknown) => {
      await ownedOpenCodeServer?.dispose()
      throw error
    })
  const disposeOwnedOpenCodeServer = async () => {
    await ownedOpenCodeServer?.dispose()
  }

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
        // Automatic startup inspection with a one-shot malformed-output
        // confirmation (issue #1076), then default-backend operator guidance.
        const guidance = yield* inspectBackendsAtStartup({
          cwd: toolCwd,
          inspectTimeout: "30 seconds",
          previewTimeout: "8 seconds",
        })
        if (guidance !== null) {
          yield* Effect.sync(() => {
            console.info(guidance)
          })
        }
      }),
    )
  } catch (error) {
    try {
      await runtime.dispose()
    } finally {
      await disposeOwnedOpenCodeServer()
    }
    throw error
  }

  return {
    context: {
      graphqlApi: createGraphqlApi(runtime, {
        agentBackendCwd: toolCwd,
        version: READY_FOR_AGENT_VERSION,
        resolveOpenCodeSessionUrl: async ({ sessionId }) => {
          const serverBase = await resolveOpenCodeServerBase()
          if (serverBase === null) return null
          return openCodeSessionWebUrl({ serverBase, sessionId })
        },
      }),
    },
    dispose: async () => {
      try {
        await runtime.dispose()
      } finally {
        await disposeOwnedOpenCodeServer()
      }
    },
  }
}
