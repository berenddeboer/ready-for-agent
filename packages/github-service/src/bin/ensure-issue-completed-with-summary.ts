import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const ensureIssueCompletedWithSummaryProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const issueNumberRaw = yield* decodeArgument(args[3], "issue number")
    const workItemId = yield* decodeArgument(args[4], "work item id")
    const summaryMarkdown = yield* decodeArgument(args[5], "summary")
    const issueNumber = Number(issueNumberRaw)
    const github = yield* GitHubService
    yield* github.ensureIssueCompletedWithSummary(
      githubRepository(forge, forgeHost, projectPath),
      issueNumber,
      workItemId,
      summaryMarkdown,
    )
    yield* writeStandardOutput(JSON.stringify({ _tag: "completed" }))
  })

if (import.meta.main)
  runGitHubCli(ensureIssueCompletedWithSummaryProgram(process.argv.slice(2)))
