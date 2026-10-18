import { Effect } from "effect"
import { GitLabService } from "../lib/gitlab-service.js"
import type { GitLabRepository } from "../lib/types.js"
import {
  CliArgumentError,
  decodeArgument,
  gitlabRepository,
  runGitLabCli,
  writeStandardOutput,
} from "./cli.js"

/**
 * Retry one project pipeline. The method stays off GitLabServiceShape so
 * test stubs do not implement it; the live service provides it.
 */
export const retryPipelineProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = gitlabRepository(
      yield* decodeArgument(args[0], "forge"),
      yield* decodeArgument(args[1], "forge host"),
      yield* decodeArgument(args[2], "project path"),
    )
    const pipelineIdRaw = yield* decodeArgument(args[3], "pipeline id")
    const pipelineId = Number(pipelineIdRaw)
    if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
      return yield* new CliArgumentError({
        message: `Invalid pipeline id: ${pipelineIdRaw}`,
      })
    }
    const gitlab = yield* GitLabService
    const retryPipeline = (
      gitlab as {
        retryPipeline?: (
          repository: GitLabRepository,
          pipelineId: number,
        ) => Effect.Effect<void, unknown>
      }
    ).retryPipeline
    if (retryPipeline === undefined) {
      return yield* new CliArgumentError({
        message: "This Forge cannot rerun CI jobs (gitlab)",
      })
    }
    yield* retryPipeline(repository, pipelineId)
    yield* writeStandardOutput("ok")
  })

if (import.meta.main) runGitLabCli(retryPipelineProgram(process.argv.slice(2)))
