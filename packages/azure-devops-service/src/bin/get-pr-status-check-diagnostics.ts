import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "../lib/azure-devops-service.js"
import {
  CliArgumentError,
  azureDevOpsRepository,
  decodeArgument,
  runAzureDevOpsCli,
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
    const repository = azureDevOpsRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const checksJson = yield* decodeArgument(args[3], "checks")
    const logDirectoryRaw = args[4]
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
    const azureDevOps = yield* AzureDevOpsService
    const diagnostics = yield* azureDevOps.getPrStatusCheckDiagnostics(
      repository,
      checks,
      logDirectory === undefined ? {} : { logDirectory },
    )
    yield* writeStandardOutput(JSON.stringify(diagnostics))
  })

if (import.meta.main)
  runAzureDevOpsCli(getPrStatusCheckDiagnosticsProgram(process.argv.slice(2)))
