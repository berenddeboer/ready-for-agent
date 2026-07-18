import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const listReadyIssuesProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = {
      owner: yield* decodeArgument(args[0], "owner"),
      name: yield* decodeArgument(args[1], "name"),
    }
    const github = yield* GitHubService
    const issues = yield* github.listReadyIssues(repository)
    yield* writeStandardOutput(JSON.stringify(issues))
  })

if (import.meta.main)
  runGitHubCli(listReadyIssuesProgram(process.argv.slice(2)))
