import { Console, Effect, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import type { LocalRepository } from "./domain.ts"
import { GraphqlApi, type RepositorySummary } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"

const pathArg = Argument.string("path").pipe(
  Argument.withDescription("Path to a local git repository"),
)

const repositoryIdPattern = /^repo-[0-9A-HJKMNP-TV-Z]{26}$/
const githubRepositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[^/]+$/

export const resolveRepositoryTarget = <E>(
  target: string,
  repositories: readonly RepositorySummary[],
  inspect: (path: string) => Effect.Effect<LocalRepository, E>,
): Effect.Effect<RepositorySummary | undefined, E> => {
  if (repositoryIdPattern.test(target)) {
    return Effect.succeed(repositories.find(({ id }) => id === target))
  }

  if (githubRepositoryPattern.test(target)) {
    const [owner, name] = target.split("/", 2)
    return Effect.succeed(
      repositories.find(
        ({ githubOwner, githubRepo }) =>
          githubOwner.toLowerCase() === owner?.toLowerCase() &&
          githubRepo.toLowerCase() === name?.toLowerCase(),
      ),
    )
  }

  return inspect(target).pipe(
    Effect.map((inspected) =>
      repositories.find(
        (repository) =>
          repository.githubOwner === inspected.githubOwner &&
          repository.githubRepo === inspected.githubRepo,
      ),
    ),
  )
}

class RepositoryNotRegistered extends Schema.TaggedErrorClass<RepositoryNotRegistered>()(
  "RepositoryNotRegistered",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail
  }
}

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
          detail: repositoryIdPattern.test(target)
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

export const cli = Command.make("harness-cli").pipe(
  Command.withDescription("CLI for the ready-for-agent harness"),
  Command.withSubcommands([addCommand, removeGitHubTokenCommand]),
)
