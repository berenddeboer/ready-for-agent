import { Effect, Schema } from "effect"
import { SpecFollowUpPublication } from "@ready-for-agent/forge-contract"
import { LinearService } from "../lib/linear-service.js"
import { decodeArgument, runLinearCli, writeStandardOutput } from "./cli.js"

export const publishSpecFollowUpsProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const projectId = yield* decodeArgument(args[0], "project id")
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SpecFollowUpPublication),
    )(yield* decodeArgument(args[1], "Spec follow-ups"))
    const linear = yield* LinearService
    const links = yield* linear.publishSpecFollowUps(projectId, input)
    yield* writeStandardOutput(JSON.stringify(links))
  })

if (import.meta.main)
  runLinearCli(publishSpecFollowUpsProgram(process.argv.slice(2)))
