import { Effect, Schema } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

const UpdateDraftCopyPayload = Schema.Struct({
  headRefName: Schema.String,
  title: Schema.String,
  body: Schema.String,
})

export const updateOpenDraftPullRequestCopyProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const payloadJson = yield* decodeArgument(
      args[2],
      "update draft copy payload",
    )
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(UpdateDraftCopyPayload),
    )(payloadJson).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError({
            message: `Invalid update open draft pull request copy payload: ${payloadJson}`,
          }),
      ),
    )
    const github = yield* GitHubService
    const number = yield* github.updateOpenDraftPullRequestCopy(
      { owner, name },
      payload.headRefName,
      {
        title: payload.title,
        body: payload.body,
      },
    )
    yield* writeStandardOutput(number === null ? "null" : String(number))
  })

if (import.meta.main)
  runGitHubCli(updateOpenDraftPullRequestCopyProgram(process.argv.slice(2)))
