import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { LocalGit } from "./services/local-git.ts"

const pathArg = Argument.string("path").pipe(
  Argument.withDescription("Path to a local git repository"),
)

const addCommand = Command.make("add", { path: pathArg }, ({ path }) =>
  Effect.gen(function* () {
    const localGit = yield* LocalGit
    const repository = yield* localGit.inspect(path)

    yield* Console.log(
      `Added repository ${repository.githubOwner}/${repository.githubRepo}`,
    )
    yield* Console.log(`  local path: ${repository.localPath}`)
    yield* Console.log(`  bare: ${repository.isBare}`)
    yield* Console.log(`  paused: ${repository.paused}`)
  }),
).pipe(Command.withDescription("Add a local repository to the harness"))

export const cli = Command.make("harness-cli").pipe(
  Command.withDescription("CLI for the ready-for-agent harness"),
  Command.withSubcommands([addCommand]),
)
