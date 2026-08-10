import { Console, Effect, Option } from "effect"
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

const forgeHostFlag = Flag.string("forge-host").pipe(
  Flag.withDescription(
    "Correct the forge host inferred from the repository remote",
  ),
  Flag.optional,
)

const projectPathFlag = Flag.string("project-path").pipe(
  Flag.withDescription(
    "Correct the forge project path inferred from the repository remote",
  ),
  Flag.optional,
)

const startHarnessWorkflow = Effect.fn("Cli.startHarness")(function* (
  noOpen: boolean,
) {
  const startHarnessService = yield* StartHarness
  yield* startHarnessService.start({ noOpen })
})

const addRepositoryWorkflow = Effect.fn("Cli.addRepository")(function* (
  path: string,
  corrections: {
    readonly forgeHost?: string
    readonly projectPath?: string
  },
) {
  const localGit = yield* LocalGit
  const graphqlApi = yield* GraphqlApi
  const inspected = yield* localGit.inspect(path)
  const repository = {
    ...inspected,
    ...(corrections.forgeHost === undefined
      ? {}
      : { forgeHost: corrections.forgeHost }),
    ...(corrections.projectPath === undefined
      ? {}
      : { projectPath: corrections.projectPath }),
  }
  const added = yield* graphqlApi.addRepository(repository)

  yield* Console.log(`Added repository ${added.projectPath}`)
  yield* Console.log(`  id: ${added.id}`)
  yield* Console.log(`  local path: ${added.localPath}`)
  yield* Console.log(`  bare: ${added.isBare}`)
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

const addCommand = Command.make(
  "add",
  {
    path: pathArg,
    forgeHost: forgeHostFlag,
    projectPath: projectPathFlag,
  },
  ({ path, forgeHost, projectPath }) =>
    addRepositoryWorkflow(path, {
      forgeHost: Option.getOrUndefined(forgeHost),
      projectPath: Option.getOrUndefined(projectPath),
    }),
).pipe(
  Command.withDescription(
    "Inspect and add a local repository; inferred GitLab identity can be corrected with flags",
  ),
)

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
