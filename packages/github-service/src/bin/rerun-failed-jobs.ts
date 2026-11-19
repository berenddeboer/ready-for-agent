import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  githubRepository,
  runGitHubCli,
} from "./cli.js"

export const rerunFailedJobsProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = githubRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const runIdRaw = yield* decodeArgument(args[3], "workflow run id")
    const runId = Number(runIdRaw)
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      return yield* new CliArgumentError({
        message: `Invalid workflow run id: ${runIdRaw}`,
      })
    }
    const github = yield* GitHubService
    const rerunFailedJobs = github.rerunFailedJobs
    if (rerunFailedJobs === undefined) {
      return yield* new CliArgumentError({
        message: "This Forge cannot retry failed CI jobs (github)",
      })
    }
    yield* rerunFailedJobs(repository, runId)
  })

if (import.meta.main)
  runGitHubCli(rerunFailedJobsProgram(process.argv.slice(2)), {
    ciRepair: true,
  })
