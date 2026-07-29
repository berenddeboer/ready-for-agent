import { Effect, Schema } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  CliArgumentError,
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

const UpdateCopyPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})

export const updateOpenDraftPullRequestCopyProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref name")
    const payloadJson = yield* decodeArgument(args[4], "update copy payload")
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(UpdateCopyPayload),
    )(payloadJson).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError({
            message: `Invalid update draft pull request payload: ${payloadJson}`,
          }),
      ),
    )
    const gitlab = yield* GitLabService
    const number = yield* gitlab.updateOpenDraftPullRequestCopy(
      repository,
      headRefName,
      { title: payload.title, body: payload.body },
    )
    yield* writeStandardOutput(number === null ? "" : String(number))
  })

if (import.meta.main)
  runGitLabCli(updateOpenDraftPullRequestCopyProgram(process.argv.slice(2)))
