import { Effect } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

export const ensureIssueCompletedWithSummaryProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const issueNumberRaw = yield* decodeArgument(args[3], "issue number")
    const workItemId = yield* decodeArgument(args[4], "work item id")
    const summaryMarkdown = yield* decodeArgument(args[5], "summary markdown")
    const issueNumber = Number(issueNumberRaw)
    const azureDevOps = yield* AzureDevOpsService
    yield* azureDevOps.ensureIssueCompletedWithSummary(
      repository,
      issueNumber,
      workItemId,
      summaryMarkdown,
    )
    yield* writeStandardOutput("ok")
  })

if (import.meta.main)
  runAzureDevOpsCli(
    ensureIssueCompletedWithSummaryProgram(process.argv.slice(2)),
  )
