import { Effect } from "effect"
import { GitHubService, GitHubServiceLive } from "../index.js"

const decodeArgument = (value: string | undefined): string => {
  if (value === undefined) throw new Error("Missing encoded argument")
  return Buffer.from(value, "base64url").toString("utf8")
}

const program = Effect.gen(function* () {
  const owner = decodeArgument(process.argv[2])
  const name = decodeArgument(process.argv[3])
  const headRefName = decodeArgument(process.argv[4])
  const github = yield* GitHubService
  const number = yield* github.getOpenPullRequestNumber(
    { owner, name },
    headRefName,
  )
  process.stdout.write(String(number))
}).pipe(
  Effect.provide(GitHubServiceLive),
  Effect.catchTag("GitHubRepositoryUnavailableError", () =>
    Effect.sync(() => process.exit(2)),
  ),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error(error)
      process.exit(1)
    }),
  ),
)

Effect.runPromise(program)
