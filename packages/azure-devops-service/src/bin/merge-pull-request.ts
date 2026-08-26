import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  CliArgumentError,
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
  writeStandardOutput,
} from "./cli.js"

const MergePullRequestOptionsPayload = Schema.Struct({
  acceptNoChecks: Schema.optional(Schema.Boolean),
})

export const mergePullRequestProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const options =
      args[4] === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MergePullRequestOptionsPayload),
          )(yield* decodeArgument(args[4], "merge options")).pipe(
            Effect.mapError(
              () =>
                new CliArgumentError({
                  message: "Invalid merge pull request options",
                }),
            ),
          )
    const azureDevOps = yield* AzureDevOpsService
    const result = yield* azureDevOps.mergePullRequest(
      repository,
      headRefName,
      options,
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runAzureDevOpsCli(mergePullRequestProgram(process.argv.slice(2)))
