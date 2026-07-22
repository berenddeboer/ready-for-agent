import { Effect } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

export const rerunWorkflowRunProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const owner = yield* decodeArgument(args[0], "owner")
    const name = yield* decodeArgument(args[1], "name")
    const workflowRunIdRaw = yield* decodeArgument(args[2], "workflow run id")
    const workflowRunId = Number(workflowRunIdRaw)
    if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
      return yield* new CliArgumentError({
        message: `Invalid workflow run id: ${workflowRunIdRaw}`,
      })
    }
    const github = yield* GitHubService
    yield* github.rerunWorkflowRun({ owner, name }, workflowRunId)
    yield* writeStandardOutput(JSON.stringify({ _tag: "rerun" as const }))
  })

if (import.meta.main)
  runGitHubCli(rerunWorkflowRunProgram(process.argv.slice(2)))
