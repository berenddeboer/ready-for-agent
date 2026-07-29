import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const mergePullRequestProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const github = yield* GitHubService
    const result = yield* github.mergePullRequest(
      githubRepository(forge, forgeHost, projectPath),
      headRefName,
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runGitHubCli(mergePullRequestProgram(process.argv.slice(2)))
