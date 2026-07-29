import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const listReadyIssuesProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const github = yield* GitHubService
    const issues = yield* github.listReadyIssues(repository)
    yield* writeStandardOutput(JSON.stringify(issues))
  })

if (import.meta.main)
  runGitHubCli(listReadyIssuesProgram(process.argv.slice(2)))
