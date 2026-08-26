import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const markPrReadyForReviewProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const azureDevOps = yield* AzureDevOpsService
    yield* azureDevOps.markPullRequestReadyForReview(repository, headRefName)
    yield* writeStandardOutput(JSON.stringify({ _tag: "ready" }))
  })

if (import.meta.main)
  runAzureDevOpsCli(markPrReadyForReviewProgram(process.argv.slice(2)))
