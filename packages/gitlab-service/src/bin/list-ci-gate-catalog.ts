import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

export const listCiGateCatalogProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const gitlab = yield* GitLabService
    const catalog = yield* gitlab.listCiGateCatalog(repository)
    yield* writeStandardOutput(JSON.stringify(catalog))
  })

if (import.meta.main)
  runGitLabCli(listCiGateCatalogProgram(process.argv.slice(2)))
