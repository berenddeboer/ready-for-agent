import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const listReadyIssuesProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const azureDevOps = yield* AzureDevOpsService
    const issues = yield* azureDevOps.listReadyIssues(repository)
    yield* writeStandardOutput(JSON.stringify(issues))
  })

if (import.meta.main)
  runAzureDevOpsCli(listReadyIssuesProgram(process.argv.slice(2)))
