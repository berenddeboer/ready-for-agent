import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const readSpecReopenEventIdProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const issueNumber = Number(yield* decodeArgument(args[3], "issue number"))
    const { readSpecReopenEventId } = yield* GitHubService
    if (!readSpecReopenEventId)
      return yield* Effect.die("Missing GitHub reopening history reader")
    const result = yield* readSpecReopenEventId(
      githubRepository(forge, forgeHost, projectPath),
      issueNumber,
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runGitHubCli(readSpecReopenEventIdProgram(process.argv.slice(2)))
