import { Effect, Schema } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import {
  CliArgumentError,
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

const ObserveCiGateArguments = Schema.Struct({
  definitionIdentities: Schema.Array(Schema.String),
  lastRunIdentities: Schema.Record(Schema.String, Schema.String),
})

export const observeCiGateProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const encodedInput = yield* decodeArgument(
      args[3],
      "CI Gate observation input",
    )
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ObserveCiGateArguments),
    )(encodedInput).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError({
            message: "Invalid CI Gate observation input argument",
          }),
      ),
    )
    const gitlab = yield* GitLabService
    const observation = yield* gitlab.observeCiGate(repository, input)
    yield* writeStandardOutput(JSON.stringify(observation))
  })

if (import.meta.main) runGitLabCli(observeCiGateProgram(process.argv.slice(2)))
