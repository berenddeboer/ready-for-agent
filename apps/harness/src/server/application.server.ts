import "@tanstack/react-start/server-only"
import { Effect, Layer, ManagedRuntime } from "effect"
import { DatabaseLive } from "@ready-for-agent/db"
import { DbServiceLive } from "@ready-for-agent/db-service"
import { GitHubServiceLive } from "@ready-for-agent/github-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerService,
  mcpKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import type { ApplicationRequestContext } from "../server-context.js"

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
  const reconcilerLayer = IssueReconcilerLive.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(GitHubServiceLive),
  )
  const appLayer = Layer.merge(
    reconcilerLayer,
    keymaxxerLayerFromEnvironment(environment),
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
      graphqlApi: createGraphqlApi(runtime),
    },
    dispose: runtime.dispose,
  }
}
