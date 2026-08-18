import { Effect, Schema } from "effect"
import { GitHubService } from "../lib/github-service.js"
import {
  CliArgumentError,
  decodeArgument,
  githubRepository,
  runGitHubCli,
  writeStandardOutput,
} from "./cli.js"

const MergePullRequestOptionsPayload = Schema.Struct({
  acceptNoChecks: Schema.optional(Schema.Boolean),
})

export const mergePullRequestProgram = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const forge = yield* decodeArgument(args[0], "forge")
    const forgeHost = yield* decodeArgument(args[1], "forge host")
    const projectPath = yield* decodeArgument(args[2], "project path")
    const headRefName = yield* decodeArgument(args[3], "head ref")
    const options =
      args[4] === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MergePullRequestOptionsPayload),
          )(yield* decodeArgument(args[4], "merge options")).pipe(
            Effect.mapError(
              () =>
                new CliArgumentError({
                  message: "Invalid merge pull request options",
                }),
            ),
          )
    const github = yield* GitHubService
    const result = yield* github.mergePullRequest(
      githubRepository(forge, forgeHost, projectPath),
      headRefName,
      options,
    )
    yield* writeStandardOutput(JSON.stringify(result))
  })

if (import.meta.main)
  runGitHubCli(mergePullRequestProgram(process.argv.slice(2)))
