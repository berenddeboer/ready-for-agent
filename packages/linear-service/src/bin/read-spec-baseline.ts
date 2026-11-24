import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const readSpecBaselineProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const includeReopening =
      args[1] === undefined
        ? false
        : (yield* decodeArgument(args[1], "include reopening")) === "true"
    const linear = yield* LinearService
    const result = yield* linear.readSpecBaseline(nativeId, {
      includeReopening,
    })
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runLinearCli(readSpecBaselineProgram(process.argv.slice(2)))
