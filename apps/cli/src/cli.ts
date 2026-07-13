import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { GraphqlApi } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"

const pathArg = Argument.string("path").pipe(
  Argument.withDescription("Path to a local git repository"),
)

const addCommand = Command.make("add", { path: pathArg }, ({ path }) =>
  Effect.gen(function* () {
    const localGit = yield* LocalGit
    const graphqlApi = yield* GraphqlApi
    const repository = yield* localGit.inspect(path)
    const added = yield* graphqlApi.addRepository(repository)

    yield* Console.log(
      `Added repository ${added.githubOwner}/${added.githubRepo}`,
    )
    yield* Console.log(`  id: ${added.id}`)
    yield* Console.log(`  local path: ${added.localPath}`)
    yield* Console.log(`  bare: ${added.isBare}`)
    yield* Console.log(`  paused: ${added.paused}`)
  }),
).pipe(Command.withDescription("Add a local repository to the harness"))

export const cli = Command.make("harness-cli").pipe(
  Command.withDescription("CLI for the ready-for-agent harness"),
  Command.withSubcommands([addCommand]),
)
