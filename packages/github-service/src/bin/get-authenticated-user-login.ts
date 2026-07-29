import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const getAuthenticatedUserLoginProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const github = yield* GitHubService
    const login = yield* github.getAuthenticatedUserLogin(repository)
    yield* writeStandardOutput(login)
  })

if (import.meta.main)
  runGitHubCli(getAuthenticatedUserLoginProgram(process.argv.slice(2)))
