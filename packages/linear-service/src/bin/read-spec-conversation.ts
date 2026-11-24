import { Effect } from "effect"
import { LinearRequestError } from "../lib/errors.js"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const readSpecConversationProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "Issue ID")
    const linear = yield* LinearService
    if (!linear.readSpecConversation)
      return yield* new LinearRequestError({
        message: "Issue conversation is unavailable",
      })
    const comments = yield* linear.readSpecConversation(nativeId)
    yield* writeStandardOutput(JSON.stringify(comments))
  })

if (import.meta.main)
  runLinearCli(readSpecConversationProgram(process.argv.slice(2)))
