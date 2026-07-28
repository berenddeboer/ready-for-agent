import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const findOpenPullRequestNumberProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const headRefName = yield* decodeArgument(args[2], "head ref")
    const github = yield* GitHubService
    const number = yield* github.findOpenPullRequestNumber(
      { owner, name },
      headRefName,
    )
    yield* writeStandardOutput(number === null ? "null" : String(number))
  })

if (import.meta.main)
  runGitHubCli(findOpenPullRequestNumberProgram(process.argv.slice(2)))
