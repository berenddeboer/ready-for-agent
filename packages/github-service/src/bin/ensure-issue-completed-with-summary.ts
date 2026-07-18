import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const ensureIssueCompletedWithSummaryProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const issueNumberRaw = yield* decodeArgument(args[2], "issue number")
    const workItemId = yield* decodeArgument(args[3], "work item id")
    const summaryMarkdown = yield* decodeArgument(args[4], "summary")
    const issueNumber = Number(issueNumberRaw)
    const github = yield* GitHubService
    yield* github.ensureIssueCompletedWithSummary(
      { owner, name },
      issueNumber,
      workItemId,
      summaryMarkdown,
    )
    yield* writeStandardOutput(JSON.stringify({ _tag: "completed" }))
  })

if (import.meta.main)
  runGitHubCli(ensureIssueCompletedWithSummaryProgram(process.argv.slice(2)))
