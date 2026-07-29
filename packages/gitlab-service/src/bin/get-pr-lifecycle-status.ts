import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const getPrLifecycleStatusProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const gitlab = yield* GitLabService
    const status = yield* gitlab.getPullRequestLifecycleStatus(
      repository,
      headRefName,
    )
    yield* writeStandardOutput(JSON.stringify(status))
  })

if (import.meta.main)
  runGitLabCli(getPrLifecycleStatusProgram(process.argv.slice(2)))
