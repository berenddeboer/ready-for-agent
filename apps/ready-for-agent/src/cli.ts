import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  FiniteCommandFailed,
  buildAddSuccessDocument,
  encodeCompactJson,
  localGitErrorCode,
} from "./cli-json.ts"
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

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription(
    "Listen host (default 127.0.0.1). Bare --host binds all interfaces (0.0.0.0); --host <addr> binds that address. Env: HOST (flag wins)",
  ),
  Flag.optional,
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
  host: string | undefined,
) {
  const startHarnessService = yield* StartHarness
  yield* startHarnessService.start({ noOpen, host })
})

const toAddCommandFailed = (error: unknown): FiniteCommandFailed => {
  if (error instanceof FiniteCommandFailed) {
    return error
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  ) {
    const tagged = error as {
      readonly _tag: string
      readonly code?: string
      readonly message?: string
    }
    if (
      tagged._tag === "GraphqlRequestFailed" &&
      typeof tagged.code === "string" &&
      typeof tagged.message === "string"
    ) {
      return new FiniteCommandFailed({
        command: "add",
        code: tagged.code,
        message: tagged.message,
      })
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof tagged.message === "string"
          ? tagged.message
          : String(error)
    return new FiniteCommandFailed({
      command: "add",
      code: localGitErrorCode(tagged._tag),
      message,
    })
  }
  return new FiniteCommandFailed({
    command: "add",
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  })
}

const addRepositoryWorkflow = Effect.fn("Cli.addRepository")(function* (
  path: string,
  corrections: {
    readonly forgeHost?: string
    readonly projectPath?: string
  },
) {
  const localGit = yield* LocalGit
  const graphqlApi = yield* GraphqlApi
  const inspected = yield* localGit
    .inspect(path)
    .pipe(Effect.mapError(toAddCommandFailed))
  const repository = {
    ...inspected,
    ...(corrections.forgeHost === undefined
      ? {}
      : { forgeHost: corrections.forgeHost }),
    ...(corrections.projectPath === undefined
      ? {}
      : { projectPath: corrections.projectPath }),
  }
  const added = yield* graphqlApi
    .addRepository(repository)
    .pipe(Effect.mapError(toAddCommandFailed))

  // Exactly one compact JSON success document on stdout; no progress chatter.
  yield* Console.log(encodeCompactJson(buildAddSuccessDocument(added)))
})

const startCommand = Command.make(
  "start",
  { noOpen: noOpenFlag, host: hostFlag },
  ({ noOpen, host }) =>
    startHarnessWorkflow(noOpen, Option.getOrUndefined(host)),
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
  { noOpen: noOpenFlag, host: hostFlag },
  ({ noOpen, host }) =>
    startHarnessWorkflow(noOpen, Option.getOrUndefined(host)),
).pipe(
  Command.withDescription(
    "Ready for Agent operator binary (start Harness, add repositories)",
  ),
  Command.withSubcommands([startCommand, addCommand]),
)
