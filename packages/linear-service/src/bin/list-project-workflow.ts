import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const listProjectWorkflowProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const projectId = yield* decodeArgument(args[0], "project id")
    const linear = yield* LinearService
    const workflow = yield* linear.listProjectWorkflow(projectId)
    yield* writeStandardOutput(JSON.stringify(workflow))
  })

if (import.meta.main)
  runLinearCli(listProjectWorkflowProgram(process.argv.slice(2)))
