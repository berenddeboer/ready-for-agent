import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const verifyProjectProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const azureDevOps = yield* AzureDevOpsService
    const resolved = yield* azureDevOps.verifyProject(repository)
    yield* writeStandardOutput(JSON.stringify(resolved))
  })

if (import.meta.main)
  runAzureDevOpsCli(verifyProjectProgram(process.argv.slice(2)))
