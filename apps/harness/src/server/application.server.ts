import "@tanstack/react-start/server-only"
import { fileURLToPath } from "node:url"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer, ManagedRuntime } from "effect"
import { DatabaseLive } from "@ready-for-agent/db"
import { DbServiceLive } from "@ready-for-agent/db-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  mcpKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import { OpencodeLive } from "@ready-for-agent/opencode"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import type { ApplicationRequestContext } from "../server-context.js"
import { JobWorkerLive } from "./job-worker.js"
import { keymaxxerGitHubLayer } from "./keymaxxer-github-layer.js"

const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url))

const keymaxxerLayerFromEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
) => {
  const sidecarUrl = environment.KEYMAXXER_SIDECAR_URL?.trim()
  return sidecarUrl === undefined || sidecarUrl === ""
    ? mcpKeymaxxerLayer({ environment })
    : sidecarKeymaxxerLayer(sidecarUrl)
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
  const databaseLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseLive))
  const keymaxxerLayer = keymaxxerLayerFromEnvironment(environment)
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
  const workerLayer = JobWorkerLive.pipe(
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(reconcilerLayer),
  )
  const opencodePlatformLayer = BunChildProcessSpawner.layer.pipe(
    Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  )
  const opencodeLayer = OpencodeLive.pipe(Layer.provide(opencodePlatformLayer))
  const appLayer =
    options.startWorker === false
      ? Layer.mergeAll(reconcilerLayer, keymaxxerLayer, opencodeLayer)
      : Layer.mergeAll(
          reconcilerLayer,
          workerLayer,
          keymaxxerLayer,
          opencodeLayer,
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
