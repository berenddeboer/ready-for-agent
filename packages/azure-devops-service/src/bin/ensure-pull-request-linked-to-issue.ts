import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const ensurePullRequestLinkedToIssueProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const pullRequestNumber = Number(
      yield* decodeArgument(args[3], "pull request number"),
    )
    const issueNumber = Number(yield* decodeArgument(args[4], "issue number"))
    const azureDevOps = yield* AzureDevOpsService
    yield* azureDevOps.ensurePullRequestLinkedToIssue(
      repository,
      pullRequestNumber,
      issueNumber,
    )
    yield* writeStandardOutput("ok")
  })

if (import.meta.main)
  runAzureDevOpsCli(
    ensurePullRequestLinkedToIssueProgram(process.argv.slice(2)),
  )
