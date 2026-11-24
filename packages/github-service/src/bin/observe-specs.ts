import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const observeSpecsProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const github = yield* GitHubService
    const observations = yield* github.observeSpecs(repository)
    yield* writeStandardOutput(JSON.stringify(observations))
  })

if (import.meta.main) runGitHubCli(observeSpecsProgram(process.argv.slice(2)))
