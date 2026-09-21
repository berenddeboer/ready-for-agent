import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const listReadyIssuesProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const projectId = yield* decodeArgument(args[0], "project id")
    const linear = yield* LinearService
    const issues = yield* linear.listReadyIssues(projectId)
    yield* writeStandardOutput(JSON.stringify(issues))
  })

if (import.meta.main)
  runLinearCli(listReadyIssuesProgram(process.argv.slice(2)))
