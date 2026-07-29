import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const listReadyIssuesProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const gitlab = yield* GitLabService
    const issues = yield* gitlab.listReadyIssues(repository)
    yield* writeStandardOutput(JSON.stringify(issues))
  })

if (import.meta.main)
  runGitLabCli(listReadyIssuesProgram(process.argv.slice(2)))
