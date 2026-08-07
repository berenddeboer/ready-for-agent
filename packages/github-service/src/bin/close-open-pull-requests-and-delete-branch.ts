import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import { decodeArgument, githubRepository, runGitHubCli } from "./cli.js"

export const closeOpenPullRequestsAndDeleteBranchProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const github = yield* GitHubService
    yield* github.closeOpenPullRequestsAndDeleteBranch(
      githubRepository(forge, forgeHost, projectPath),
      headRefName,
    )
  })

if (import.meta.main)
  runGitHubCli(
    closeOpenPullRequestsAndDeleteBranchProgram(process.argv.slice(2)),
  )
