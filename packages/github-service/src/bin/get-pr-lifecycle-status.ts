import { Effect } from "effect"
import { GitHubService } from "../index.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

const program = Effect.gen(function* () {
  const owner = yield* decodeArgument(process.argv[2], "owner")
  const name = yield* decodeArgument(process.argv[3], "name")
  const headRefName = yield* decodeArgument(process.argv[4], "head ref")
  const github = yield* GitHubService
  const status = yield* github.getPullRequestLifecycleStatus(
    { owner, name },
    headRefName,
  )
  yield* writeStandardOutput(JSON.stringify(status))
})

if (import.meta.main) runGitHubCli(program)
