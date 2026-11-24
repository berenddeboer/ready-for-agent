import { Effect, Schema } from "effect"
import { GitHubRequestError } from "../lib/errors.js"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const readSpecConversationProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const issue = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Union([Schema.Int, Schema.NonEmptyString])),
    )(yield* decodeArgument(args[3], "Issue identity"))
    const github = yield* GitHubService
    if (!github.readSpecConversation)
      return yield* new GitHubRequestError({
        message: "Issue conversation is unavailable",
      })
    const comments = yield* github.readSpecConversation(repository, issue)
    yield* writeStandardOutput(JSON.stringify(comments))
  })

if (import.meta.main)
  runGitHubCli(readSpecConversationProgram(process.argv.slice(2)))
