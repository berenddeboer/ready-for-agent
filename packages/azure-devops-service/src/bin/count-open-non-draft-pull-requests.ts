import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const countOpenNonDraftPullRequestsProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const azureDevOps = yield* AzureDevOpsService
    const count = yield* azureDevOps.countOpenNonDraftPullRequests(repository)
    yield* writeStandardOutput(String(count))
  })

if (import.meta.main)
  runAzureDevOpsCli(countOpenNonDraftPullRequestsProgram(process.argv.slice(2)))
