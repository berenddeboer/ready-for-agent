import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { GraphqlApi } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import { StartHarness } from "./services/start-harness.ts"

const pathArg = Argument.string("path").pipe(
  Argument.withDescription("Path to a local git repository"),
)

const noOpenFlag = Flag.boolean("no-open").pipe(
  Flag.withDescription(
    "Do not open the default browser after a successful start (also: NO_BROWSER)",
  ),
)

const startHarnessWorkflow = Effect.fn("Cli.startHarness")(function* (
  noOpen: boolean,
) {
  const startHarnessService = yield* StartHarness
  yield* startHarnessService.start({ noOpen })
})

const addRepositoryWorkflow = Effect.fn("Cli.addRepository")(function* (
  path: string,
) {
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
})

const startCommand = Command.make(
  "start",
  { noOpen: noOpenFlag },
  ({ noOpen }) => startHarnessWorkflow(noOpen),
).pipe(
  Command.withDescription(
    "Start the full Harness (UI + backend); opens the browser unless --no-open / NO_BROWSER",
  ),
)

const addCommand = Command.make("add", { path: pathArg }, ({ path }) =>
  addRepositoryWorkflow(path),
).pipe(Command.withDescription("Add a local repository to the harness"))

export const cli = Command.make(
  "ready-for-agent",
  { noOpen: noOpenFlag },
  ({ noOpen }) => startHarnessWorkflow(noOpen),
).pipe(
  Command.withDescription(
    "Ready for Agent operator binary (start Harness, add repositories)",
  ),
  Command.withSubcommands([startCommand, addCommand]),
)
