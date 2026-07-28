import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const countOpenNonDraftPullRequestsProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const github = yield* GitHubService
    const count = yield* github.countOpenNonDraftPullRequests({ owner, name })
    yield* writeStandardOutput(String(count))
  })

if (import.meta.main)
  runGitHubCli(countOpenNonDraftPullRequestsProgram(process.argv.slice(2)))
