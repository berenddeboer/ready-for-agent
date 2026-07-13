import { Effect, Result } from "effect"
import {
  GitHubRepositoryUnavailableError,
  GitHubService,
  GitHubServiceLive,
} from "../index.js"

const decodeArgument = (value: string | undefined): string => {
  if (value === undefined) throw new Error("Missing Repository argument")
  return Buffer.from(value, "base64url").toString("utf8")
}

if (import.meta.main) {
  const repository = {
    owner: decodeArgument(process.argv[2]),
    name: decodeArgument(process.argv[3]),
  }
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* github.listReadyIssues(repository)
    }).pipe(Effect.provide(GitHubServiceLive), Effect.result),
  )

  if (Result.isSuccess(result)) {
    process.stdout.write(JSON.stringify(result.success))
  } else if (result.failure instanceof GitHubRepositoryUnavailableError) {
    process.exitCode = 2
  } else {
    process.stderr.write("GitHub query failed\n")
    process.exitCode = 1
  }
}
