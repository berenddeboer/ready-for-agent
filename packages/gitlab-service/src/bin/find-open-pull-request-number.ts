import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const findOpenPullRequestNumberProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref name")
    const gitlab = yield* GitLabService
    const number = yield* gitlab.findOpenPullRequestNumber(
      repository,
      headRefName,
    )
    yield* writeStandardOutput(number === null ? "" : String(number))
  })

if (import.meta.main)
  runGitLabCli(findOpenPullRequestNumberProgram(process.argv.slice(2)))
