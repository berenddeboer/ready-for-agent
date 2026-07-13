import "@tanstack/react-start/server-only"
import { fileURLToPath } from "node:url"
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
import type { ApplicationRequestContext } from "../server-context.js"
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

export const createApplication = async (
  environment: Partial<Record<string, string | undefined>> = process.env,
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
  const appLayer = Layer.merge(reconcilerLayer, keymaxxerLayer)
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
      graphqlApi: createGraphqlApi(runtime),
    },
    dispose: runtime.dispose,
  }
}
