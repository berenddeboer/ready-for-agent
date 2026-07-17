import { Effect } from "effect"
import type { LocalRepository } from "./domain.ts"

export type RepositorySummary = {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
}

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

export const isRepositoryId = (target: string): boolean =>
  repositoryIdPattern.test(target)
