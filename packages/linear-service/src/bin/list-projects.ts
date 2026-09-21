import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { runLinearCli, writeStandardOutput } from "./cli.js"

export const listProjectsProgram = (_args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    const projects = yield* linear.listProjects()
    yield* writeStandardOutput(JSON.stringify(projects))
  })

if (import.meta.main) runLinearCli(listProjectsProgram(process.argv.slice(2)))
