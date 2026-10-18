import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import type { AzureDevOpsRepository } from "../lib/types.js"
import {
  CliArgumentError,
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

/**
 * Retry one build. The method stays off AzureDevOpsServiceShape so test
 * stubs do not implement it; the live service provides it.
 */
export const retryBuildProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const buildIdRaw = yield* decodeArgument(args[3], "build id")
    const buildId = Number(buildIdRaw)
    if (!Number.isSafeInteger(buildId) || buildId <= 0) {
      return yield* new CliArgumentError({
        message: `Invalid build id: ${buildIdRaw}`,
      })
    }
    const azureDevOps = yield* AzureDevOpsService
    const retryBuild = (
      azureDevOps as {
        retryBuild?: (
          repository: AzureDevOpsRepository,
          buildId: number,
        ) => Effect.Effect<void, unknown>
      }
    ).retryBuild
    if (retryBuild === undefined) {
      return yield* new CliArgumentError({
        message: "This Forge cannot rerun CI jobs (azure-devops)",
      })
    }
    yield* retryBuild(repository, buildId)
    yield* writeStandardOutput("ok")
  })

if (import.meta.main)
  runAzureDevOpsCli(retryBuildProgram(process.argv.slice(2)))
