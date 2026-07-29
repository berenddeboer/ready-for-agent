import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const countOpenNonDraftPullRequestsProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const github = yield* GitHubService
    const count = yield* github.countOpenNonDraftPullRequests(
      githubRepository(forge, forgeHost, projectPath),
    )
    yield* writeStandardOutput(String(count))
  })

if (import.meta.main)
  runGitHubCli(countOpenNonDraftPullRequestsProgram(process.argv.slice(2)))
