import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const readSpecBaselineProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const linear = yield* LinearService
    const result = yield* linear.readSpecBaseline(nativeId)
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runLinearCli(readSpecBaselineProgram(process.argv.slice(2)))
