import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const closeOpenPullRequestsForBranchProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref name")
    const gitlab = yield* GitLabService
    yield* gitlab.closeOpenPullRequestsForBranch(repository, headRefName)
    yield* writeStandardOutput("ok")
  })

if (import.meta.main)
  runGitLabCli(closeOpenPullRequestsForBranchProgram(process.argv.slice(2)))
