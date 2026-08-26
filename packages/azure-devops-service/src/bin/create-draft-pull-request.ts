import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  CliArgumentError,
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
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
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const payloadJson = yield* decodeArgument(args[3], "create draft payload")
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
    const azureDevOps = yield* AzureDevOpsService
    const number = yield* azureDevOps.createDraftPullRequest(repository, {
      headRefName: payload.headRefName,
      title: payload.title,
      body: payload.body,
      ...(payload.baseRefName === undefined
        ? {}
        : { baseRefName: payload.baseRefName }),
    })
    yield* writeStandardOutput(String(number))
  })

if (import.meta.main)
  runAzureDevOpsCli(createDraftPullRequestProgram(process.argv.slice(2)))
