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

export const getPrStatusCheckDiagnosticsProgram = (
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const checksJson = yield* decodeArgument(args[2], "checks")
    const logDirectoryRaw = args[3]
    const logDirectory =
      logDirectoryRaw === undefined || logDirectoryRaw === ""
        ? undefined
        : yield* decodeArgument(logDirectoryRaw, "log directory")
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
    const diagnostics = yield* github.getPrStatusCheckDiagnostics(
      { owner, name },
      checks,
      logDirectory === undefined ? {} : { logDirectory },
    )
    yield* writeStandardOutput(JSON.stringify(diagnostics))
  })

if (import.meta.main)
  runGitHubCli(getPrStatusCheckDiagnosticsProgram(process.argv.slice(2)))
