import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const readSpecBaselineProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const issueNumber = Number(yield* decodeArgument(args[3], "issue number"))
    const includeReopening =
      args[4] === undefined
        ? false
        : (yield* decodeArgument(args[4], "include reopening")) === "true"
    const github = yield* GitHubService
    const result = yield* github.readSpecBaseline(
      githubRepository(forge, forgeHost, projectPath),
      issueNumber,
      { includeReopening },
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runGitHubCli(readSpecBaselineProgram(process.argv.slice(2)))
