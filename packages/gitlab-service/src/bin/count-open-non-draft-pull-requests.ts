import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const countOpenNonDraftPullRequestsProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const gitlab = yield* GitLabService
    const count = yield* gitlab.countOpenNonDraftPullRequests(repository)
    yield* writeStandardOutput(String(count))
  })

if (import.meta.main)
  runGitLabCli(countOpenNonDraftPullRequestsProgram(process.argv.slice(2)))
