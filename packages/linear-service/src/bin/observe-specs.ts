import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const observeSpecsProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const projectId = yield* decodeArgument(args[0], "project id")
    const linear = yield* LinearService
    const observations = yield* linear.observeSpecs(projectId)
    yield* writeStandardOutput(JSON.stringify(observations))
  })

if (import.meta.main) runLinearCli(observeSpecsProgram(process.argv.slice(2)))
