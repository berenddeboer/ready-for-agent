import { Effect } from "effect"
import { GitHubRequestError } from "../lib/errors.js"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const ensureIssueCommentProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const issueNumber = yield* decodeArgument(args[3], "issue number")
    const marker = yield* decodeArgument(args[4], "comment marker")
    const markdown = yield* decodeArgument(args[5], "comment markdown")
    const github = yield* GitHubService
    if (!github.ensureIssueComment) {
      return yield* new GitHubRequestError({
        message: "GitHub Issue comment publication is not configured",
      })
    }
    yield* github.ensureIssueComment(
      githubRepository(forge, forgeHost, projectPath),
      Number(issueNumber),
      marker,
      markdown,
    )
    yield* writeStandardOutput(JSON.stringify({ _tag: "commented" }))
  })

if (import.meta.main)
  runGitHubCli(ensureIssueCommentProgram(process.argv.slice(2)))
