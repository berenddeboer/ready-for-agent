import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const verifyProjectProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const gitlab = yield* GitLabService
    const resolved = yield* gitlab.verifyProject(repository)
    yield* writeStandardOutput(JSON.stringify(resolved))
  })

if (import.meta.main) runGitLabCli(verifyProjectProgram(process.argv.slice(2)))
