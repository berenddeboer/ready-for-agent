import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const getOpenPullRequestNumberProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref name")
    const azureDevOps = yield* AzureDevOpsService
    const number = yield* azureDevOps.getOpenPullRequestNumber(
      repository,
      headRefName,
    )
    yield* writeStandardOutput(String(number))
  })

if (import.meta.main)
  runAzureDevOpsCli(getOpenPullRequestNumberProgram(process.argv.slice(2)))
