import { Effect, Schema } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

const ChecksArgument = Schema.Array(
  Schema.Struct({
    externalId: Schema.String,
    name: Schema.String,
  }),
)

export const observeAutomatedReviewEvidenceProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const headRefName = yield* decodeArgument(args[2], "head ref name")
    const checksJson = yield* decodeArgument(args[3], "checks")
    const parsed = yield* Effect.try({
      try: () => JSON.parse(checksJson) as unknown,
      catch: () => new CliArgumentError({ message: "Invalid checks argument" }),
    })
    const checks = yield* Schema.decodeUnknownEffect(ChecksArgument)(
      parsed,
    ).pipe(
      Effect.mapError(
        () => new CliArgumentError({ message: "Invalid checks argument" }),
      ),
    )
    const github = yield* GitHubService
    const observation = yield* github.observeAutomatedReviewEvidence(
      { owner, name },
      headRefName,
      checks,
    )
    yield* writeStandardOutput(JSON.stringify(observation))
  })

if (import.meta.main)
  runGitHubCli(observeAutomatedReviewEvidenceProgram(process.argv.slice(2)))
