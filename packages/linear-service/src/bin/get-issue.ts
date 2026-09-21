import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const getIssueProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const linear = yield* LinearService
    const issue = yield* linear.getIssue(nativeId)
    yield* writeStandardOutput(JSON.stringify(issue))
  })

if (import.meta.main) runLinearCli(getIssueProgram(process.argv.slice(2)))
