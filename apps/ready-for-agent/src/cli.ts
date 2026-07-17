import { Console, Effect, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  isRepositoryId,
  resolveRepositoryTarget,
} from "./resolve-repository-target.ts"
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

class RepositoryNotRegistered extends Schema.TaggedErrorClass<RepositoryNotRegistered>()(
  "RepositoryNotRegistered",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail
  }
}

const startHarness = (noOpen: boolean) =>
  Effect.gen(function* () {
    const startHarnessService = yield* StartHarness
    yield* startHarnessService.start({ noOpen })
  })

const startCommand = Command.make(
  "start",
  { noOpen: noOpenFlag },
  ({ noOpen }) => startHarness(noOpen),
).pipe(
  Command.withDescription(
    "Start the full Harness (UI + backend); opens the browser unless --no-open / NO_BROWSER",
  ),
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

const targetArg = Argument.string("target").pipe(
  Argument.withDescription(
    "Local path, owner/repository, or repository id (repo-…)",
  ),
)

const removeGitHubTokenCommand = Command.make(
  "remove-github-token",
  { target: targetArg },
  ({ target }) =>
    Effect.gen(function* () {
      const graphqlApi = yield* GraphqlApi
      const repositories = yield* graphqlApi.listRepositories
      const localGit = yield* LocalGit
      const repository = yield* resolveRepositoryTarget(
        target,
        repositories,
        localGit.inspect,
      )

      if (repository === undefined) {
        return yield* new RepositoryNotRegistered({
          detail: isRepositoryId(target)
            ? `Repository not registered: ${target}`
            : `No registered repository matches ${target}`,
        })
      }

      const credential = yield* graphqlApi.removeRepositoryGitHubToken(
        repository.id,
      )

      yield* Console.log(
        `Removed GitHub token for ${repository.githubOwner}/${repository.githubRepo}`,
      )
      yield* Console.log(`  secret: ${credential.githubTokenSecretName}`)
    }),
).pipe(
  Command.withDescription(
    "Remove the Keymaxxer GitHub token for a registered repository",
  ),
)

export const cli = Command.make(
  "ready-for-agent",
  { noOpen: noOpenFlag },
  ({ noOpen }) => startHarness(noOpen),
).pipe(
  Command.withDescription(
    "Ready for Agent operator binary (start Harness, add repositories, manage tokens)",
  ),
  Command.withSubcommands([startCommand, addCommand, removeGitHubTokenCommand]),
)
