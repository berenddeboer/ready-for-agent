import { Effect, Schema } from "effect"
import { SpecFollowUpPublication } from "@ready-for-agent/forge-contract"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const publishSpecFollowUpsProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SpecFollowUpPublication),
    )(yield* decodeArgument(args[3], "Spec follow-ups"))
    const github = yield* GitHubService
    const links = yield* github.publishSpecFollowUps(repository, input)
    yield* writeStandardOutput(JSON.stringify(links))
  })

if (import.meta.main)
  runGitHubCli(publishSpecFollowUpsProgram(process.argv.slice(2)))
