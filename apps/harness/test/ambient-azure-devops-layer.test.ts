import { Effect } from "effect"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "@ready-for-agent/azure-devops-service"
import { ambientAzureDevOpsLayer } from "../src/server/ambient-azure-devops-layer.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "azure-devops" as const,
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

const runWithEnv = <A, E>(
  environment: Partial<Record<string, string | undefined>>,
  use: (service: AzureDevOpsServiceShape) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AzureDevOpsService
      return yield* use(service)
    }).pipe(Effect.provide(ambientAzureDevOpsLayer(environment))),
  )

describe("ambientAzureDevOpsLayer", () => {
  test("reports credentials present when AZURE_DEVOPS_EXT_PAT resolves", async () => {
    await expect(
      runWithEnv({ AZURE_DEVOPS_EXT_PAT: "s3cr3t" }, (service) =>
        service.hasCredentials(repository),
      ),
    ).resolves.toBe(true)
  })

  test("reports no credentials when AZURE_DEVOPS_EXT_PAT is unset", async () => {
    await expect(
      runWithEnv({}, (service) => service.hasCredentials(repository)),
    ).resolves.toBe(false)
    await expect(
      runWithEnv({}, (service) => service.hasAmbientCredentials(repository)),
    ).resolves.toBe(false)
  })

  test("reports no credentials when AZURE_DEVOPS_EXT_PAT is blank", async () => {
    await expect(
      runWithEnv({ AZURE_DEVOPS_EXT_PAT: "   " }, (service) =>
        service.hasCredentials(repository),
      ),
    ).resolves.toBe(false)
  })

  test("defaults to process.env when no environment is provided", async () => {
    const previous = process.env.AZURE_DEVOPS_EXT_PAT
    delete process.env.AZURE_DEVOPS_EXT_PAT
    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* AzureDevOpsService
            return yield* service.hasCredentials(repository)
          }).pipe(Effect.provide(ambientAzureDevOpsLayer())),
        ),
      ).resolves.toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.AZURE_DEVOPS_EXT_PAT
      } else {
        process.env.AZURE_DEVOPS_EXT_PAT = previous
      }
    }
  })
})
