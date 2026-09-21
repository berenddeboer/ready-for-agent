import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { runLinearCli, writeStandardOutput } from "./cli.js"

export const getAuthenticatedUserLoginProgram = (
  _args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const linear = yield* LinearService
    const login = yield* linear.getAuthenticatedUserLogin()
    yield* writeStandardOutput(login)
  })

if (import.meta.main)
  runLinearCli(getAuthenticatedUserLoginProgram(process.argv.slice(2)))
