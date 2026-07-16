import { Effect } from "effect"
import { GitHubService } from "../index.js"
import { decodeArgument, runGitHubCli, writeStandardOutput } from "./cli.js"

const program = Effect.gen(function* () {
  const repository = {
    owner: yield* decodeArgument(process.argv[2], "owner"),
    name: yield* decodeArgument(process.argv[3], "name"),
  }
  const github = yield* GitHubService
  const issues = yield* github.listReadyIssues(repository)
  yield* writeStandardOutput(JSON.stringify(issues))
})

if (import.meta.main) runGitHubCli(program)
