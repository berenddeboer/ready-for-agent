import { Effect, Schema } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

const CreateDraftPullRequestPayload = Schema.Struct({
  headRefName: Schema.String,
  title: Schema.String,
  body: Schema.String,
  baseRefName: Schema.optional(Schema.String),
})

export const createDraftPullRequestProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const payloadJson = yield* decodeArgument(args[2], "create draft payload")
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CreateDraftPullRequestPayload),
    )(payloadJson).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError({
            message: `Invalid create draft pull request payload: ${payloadJson}`,
          }),
      ),
    )
    const github = yield* GitHubService
    const number = yield* github.createDraftPullRequest(
      { owner, name },
      {
        headRefName: payload.headRefName,
        title: payload.title,
        body: payload.body,
        ...(payload.baseRefName === undefined
          ? {}
          : { baseRefName: payload.baseRefName }),
      },
    )
    yield* writeStandardOutput(String(number))
  })

if (import.meta.main)
  runGitHubCli(createDraftPullRequestProgram(process.argv.slice(2)))
