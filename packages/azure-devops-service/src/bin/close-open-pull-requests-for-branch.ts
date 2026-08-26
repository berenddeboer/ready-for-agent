import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const closeOpenPullRequestsForBranchProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref name")
    const azureDevOps = yield* AzureDevOpsService
    yield* azureDevOps.closeOpenPullRequestsForBranch(repository, headRefName)
    yield* writeStandardOutput("ok")
  })

if (import.meta.main)
  runAzureDevOpsCli(
    closeOpenPullRequestsForBranchProgram(process.argv.slice(2)),
  )
