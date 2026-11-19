import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const readCiRepairRunProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const runIdRaw = yield* decodeArgument(args[3], "workflow run id")
    const runId = Number(runIdRaw)
    const attempt = Number(yield* decodeArgument(args[4], "original attempt"))
    if (
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !Number.isSafeInteger(attempt) ||
      attempt <= 0
    ) {
      return yield* new CliArgumentError({
        message: `Invalid workflow run id: ${runIdRaw}`,
      })
    }
    const github = yield* GitHubService
    const readCiRepairRun = github.readCiRepairRun
    if (readCiRepairRun === undefined) {
      return yield* new CliArgumentError({
        message: "This Forge cannot observe a CI retry (github)",
      })
    }
    const run = yield* readCiRepairRun(repository, runId, attempt)
    yield* writeStandardOutput(JSON.stringify(run))
  })

if (import.meta.main)
  runGitHubCli(readCiRepairRunProgram(process.argv.slice(2)), {
    ciRepair: true,
  })
