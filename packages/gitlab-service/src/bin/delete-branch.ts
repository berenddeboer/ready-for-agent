import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const deleteBranchProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const branchName = yield* decodeArgument(args[3], "branch name")
    const gitlab = yield* GitLabService
    yield* gitlab.deleteBranch(repository, branchName)
    yield* writeStandardOutput("ok")
  })

if (import.meta.main) runGitLabCli(deleteBranchProgram(process.argv.slice(2)))
