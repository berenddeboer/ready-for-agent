import { Effect, Schema } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

const UploadUserAttachmentPayload = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  filePath: Schema.String,
})

export const uploadUserAttachmentProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const payloadJson = yield* decodeArgument(args[3], "upload payload")
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(UploadUserAttachmentPayload),
    )(payloadJson).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError({
            message: `Invalid upload user attachment payload: ${payloadJson}`,
          }),
      ),
    )
    const github = yield* GitHubService
    const url = yield* github.uploadUserAttachment(
      githubRepository(forge, forgeHost, projectPath),
      {
        name: payload.name,
        contentType: payload.contentType,
        filePath: payload.filePath,
      },
    )
    yield* writeStandardOutput(url)
  })

if (import.meta.main)
  runGitHubCli(uploadUserAttachmentProgram(process.argv.slice(2)))
