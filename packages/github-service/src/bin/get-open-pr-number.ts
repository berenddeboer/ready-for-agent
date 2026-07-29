import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const getOpenPullRequestNumberProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const github = yield* GitHubService
    const number = yield* github.getOpenPullRequestNumber(
      githubRepository(forge, forgeHost, projectPath),
      headRefName,
    )
    yield* writeStandardOutput(String(number))
  })

if (import.meta.main)
  runGitHubCli(getOpenPullRequestNumberProgram(process.argv.slice(2)))
