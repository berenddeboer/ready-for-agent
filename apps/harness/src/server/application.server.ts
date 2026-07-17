import "@tanstack/react-start/server-only"
import { fileURLToPath } from "node:url"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { DatabaseLive } from "@ready-for-agent/db"
import { DbServiceLive } from "@ready-for-agent/db-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  disabledKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleStepsLive,
  WorkItemLifecycleLive,
} from "@ready-for-agent/work-item-lifecycle"
import type { ApplicationRequestContext } from "../server-context.js"
import { JobWorkerLive } from "./job-worker.js"
import { keymaxxerGitHubLayer } from "./keymaxxer-github-layer.js"

const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url))

const keymaxxerSidecarUrlFromEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
) => {
  if (environment.KEYMAXXER_ENABLED?.trim().toLowerCase() === "false") {
    return undefined
  }
  const sidecarUrl = environment.KEYMAXXER_SIDECAR_URL?.trim()
  if (sidecarUrl === undefined || sidecarUrl === "") {
    throw new Error(
      "KEYMAXXER_SIDECAR_URL is required (capability URL from the Keymaxxer Sidecar bootstrap line)",
    )
  }
  return sidecarUrl
}

export interface Application {
  readonly context: ApplicationRequestContext
  readonly dispose: () => Promise<void>
}

export interface CreateApplicationOptions {
  readonly startWorker?: boolean
}

export const createApplication = async (
  environment: Partial<Record<string, string | undefined>> = process.env,
  options: CreateApplicationOptions = {},
): Promise<Application> => {
  const sidecarUrl = keymaxxerSidecarUrlFromEnvironment(environment)
  const databaseLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseLive))
  const keymaxxerLayer =
    sidecarUrl === undefined
      ? disabledKeymaxxerLayer
      : sidecarKeymaxxerLayer(sidecarUrl)
  const githubLayer = keymaxxerGitHubLayer({ workspaceRoot }).pipe(
    Layer.provide(keymaxxerLayer),
  )
  const reconcilerLayer = IssueReconcilerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(githubLayer),
  )
  const queueLayer = SqliteQueueServiceLive.pipe(
    Layer.provideMerge(databaseLayer),
  )
  const opencodePlatformLayer = BunChildProcessSpawner.layer.pipe(
    Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  )
  const opencodeLayer = Opencode.layer({
    ...(sidecarUrl === undefined ? {} : { keymaxxerMcpUrl: sidecarUrl }),
  }).pipe(Layer.provide(opencodePlatformLayer))
  const lifecycleLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(LifecycleStepsLive),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(opencodeLayer),
    Layer.provideMerge(keymaxxerLayer),
    Layer.provideMerge(githubLayer),
    Layer.provide(opencodePlatformLayer),
  )
  const workerLayer = JobWorkerLive.pipe(
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(reconcilerLayer),
    Layer.provideMerge(lifecycleLayer),
    Layer.provideMerge(keymaxxerLayer),
  )
  const loggingLayer = Logger.layer([Logger.consolePretty({ colors: false })])
  const appLayer =
    options.startWorker === false
      ? Layer.mergeAll(
          reconcilerLayer,
          queueLayer,
          keymaxxerLayer,
          opencodeLayer,
          lifecycleLayer,
          loggingLayer,
        )
      : Layer.mergeAll(
          reconcilerLayer,
          workerLayer,
          queueLayer,
          keymaxxerLayer,
          opencodeLayer,
          lifecycleLayer,
          loggingLayer,
        )
  const runtime = ManagedRuntime.make(appLayer)

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const keymaxxer = yield* KeymaxxerService
        yield* keymaxxer.initialize
      }),
    )
  } catch (error) {
    await runtime.dispose()
    throw error
  }

  return {
    context: {
      graphqlApi: createGraphqlApi(runtime, { opencodeCwd: workspaceRoot }),
    },
    dispose: runtime.dispose,
  }
}
