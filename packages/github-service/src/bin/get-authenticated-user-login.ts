import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

export const getAuthenticatedUserLoginProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = {
      owner: yield* decodeArgument(args[0], "owner"),
      name: yield* decodeArgument(args[1], "name"),
    }
    const github = yield* GitHubService
    const login = yield* github.getAuthenticatedUserLogin(repository)
    yield* writeStandardOutput(login)
  })

if (import.meta.main)
  runGitHubCli(getAuthenticatedUserLoginProgram(process.argv.slice(2)))
