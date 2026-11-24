import { Effect, Schema } from "effect"
import { SpecCloseGuard } from "@ready-for-agent/forge-contract"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const closePassingSpecProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const doneStateId = yield* decodeArgument(args[1], "Done state id")
    const verdictId = yield* decodeArgument(args[2], "verdict ID")
    const summary = yield* decodeArgument(args[3], "verdict summary")
    const guard = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SpecCloseGuard),
    )(yield* decodeArgument(args[4], "validated Spec opening and hierarchy"))
    const { closePassingSpec } = yield* LinearService
    if (!closePassingSpec)
      return yield* Effect.die("Missing Linear Spec close-out")
    const result = yield* closePassingSpec({
      nativeId,
      doneStateId,
      verdictId,
      summary,
      guard,
    })
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runLinearCli(closePassingSpecProgram(process.argv.slice(2)))
