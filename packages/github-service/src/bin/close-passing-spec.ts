import { Effect, Schema } from "effect"
import { SpecCloseGuard } from "@ready-for-agent/forge-contract"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const closePassingSpecProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const issueNumber = Number(yield* decodeArgument(args[3], "issue number"))
    const verdictId = yield* decodeArgument(args[4], "verdict ID")
    const summary = yield* decodeArgument(args[5], "verdict summary")
    const guard = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SpecCloseGuard),
    )(yield* decodeArgument(args[6], "validated Spec opening and hierarchy"))
    const { closePassingSpec } = yield* GitHubService
    if (!closePassingSpec)
      return yield* Effect.die("Missing GitHub Spec close-out")
    const result = yield* closePassingSpec(
      githubRepository(forge, forgeHost, projectPath),
      issueNumber,
      verdictId,
      summary,
      guard,
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runGitHubCli(closePassingSpecProgram(process.argv.slice(2)))
