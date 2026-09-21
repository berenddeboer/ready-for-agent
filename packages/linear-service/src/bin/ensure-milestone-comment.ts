import { Effect } from "effect"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli } from "./cli.js"

export const ensureMilestoneCommentProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const nativeId = yield* decodeArgument(args[0], "issue id")
    const marker = yield* decodeArgument(args[1], "comment marker")
    const body = yield* decodeArgument(args[2], "comment body")
    const linear = yield* LinearService
    yield* linear.ensureMilestoneComment(nativeId, marker, body)
  })

if (import.meta.main)
  runLinearCli(ensureMilestoneCommentProgram(process.argv.slice(2)))
