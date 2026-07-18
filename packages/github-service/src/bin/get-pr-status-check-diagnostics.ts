import { Effect, Schema } from "effect"
import { GitHubService } from "../index.js"
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

const program = Effect.gen(function* () {
  const owner = yield* decodeArgument(process.argv[2], "owner")
  const name = yield* decodeArgument(process.argv[3], "name")
  const checksJson = yield* decodeArgument(process.argv[4], "checks")
  const logDirectoryRaw = process.argv[5]
  const logDirectory =
    logDirectoryRaw === undefined || logDirectoryRaw === ""
      ? undefined
      : yield* decodeArgument(logDirectoryRaw, "log directory")
  const parsed = yield* Effect.try({
    try: () => JSON.parse(checksJson) as unknown,
    catch: () => new CliArgumentError({ message: "Invalid checks argument" }),
  })
  const checks = yield* Schema.decodeUnknownEffect(ChecksArgument)(parsed).pipe(
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

if (import.meta.main) runGitHubCli(program)
