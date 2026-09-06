import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const listCiGateCatalogProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const github = yield* GitHubService
    const catalog = yield* github.listCiGateCatalog(repository)
    yield* writeStandardOutput(JSON.stringify(catalog))
  })

if (import.meta.main)
  runGitHubCli(listCiGateCatalogProgram(process.argv.slice(2)))
