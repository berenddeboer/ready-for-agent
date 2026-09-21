import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli } from "./cli.js"

export const updateIssueStateProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const stateId = yield* decodeArgument(args[1], "state id")
    const linear = yield* LinearService
    yield* linear.updateIssueState(nativeId, stateId)
  })

if (import.meta.main)
  runLinearCli(updateIssueStateProgram(process.argv.slice(2)))
