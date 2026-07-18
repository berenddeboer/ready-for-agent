import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const markPrReadyForReviewProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const headRefName = yield* decodeArgument(args[2], "head ref")
    const github = yield* GitHubService
    yield* github.markPullRequestReadyForReview({ owner, name }, headRefName)
    yield* writeStandardOutput(JSON.stringify({ _tag: "ready" }))
  })

if (import.meta.main)
  runGitHubCli(markPrReadyForReviewProgram(process.argv.slice(2)))
