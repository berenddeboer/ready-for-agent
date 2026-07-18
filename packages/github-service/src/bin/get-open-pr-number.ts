import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const getOpenPullRequestNumberProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const headRefName = yield* decodeArgument(args[2], "head ref")
    const github = yield* GitHubService
    const number = yield* github.getOpenPullRequestNumber(
      { owner, name },
      headRefName,
    )
    yield* writeStandardOutput(String(number))
  })

if (import.meta.main)
  runGitHubCli(getOpenPullRequestNumberProgram(process.argv.slice(2)))
