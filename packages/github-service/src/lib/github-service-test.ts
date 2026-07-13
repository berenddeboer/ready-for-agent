import { Effect, Layer } from "effect"
import {
  GitHubRepositoryUnavailableError,
  type GitHubRequestError,
} from "./errors.js"
import { GitHubService } from "./github-service.js"
import type { GitHubRepository, ReadyLabeledIssue } from "./types.js"

interface GitHubServiceTestFixtureBase {
  readonly repository: GitHubRepository
}

export interface GitHubServiceTestIssuesFixture
  extends GitHubServiceTestFixtureBase {
  readonly issues: readonly ReadyLabeledIssue[]
  readonly error?: never
}

export interface GitHubServiceTestErrorFixture
  extends GitHubServiceTestFixtureBase {
  readonly error: GitHubRequestError
  readonly issues?: never
}

export type GitHubServiceTestFixture =
  | GitHubServiceTestIssuesFixture
  | GitHubServiceTestErrorFixture

const repositoryKey = ({ owner, name }: GitHubRepository): string =>
  `${owner.toLowerCase()}/${name.toLowerCase()}`

export const makeGitHubServiceTest = (
  fixtures: readonly GitHubServiceTestFixture[],
): Layer.Layer<GitHubService> => {
  const fixturesByRepository = new Map(
    fixtures.map((fixture) => [repositoryKey(fixture.repository), fixture]),
  )

  return Layer.succeed(GitHubService, {
    listReadyIssues: (repository) => {
      const fixture = fixturesByRepository.get(repositoryKey(repository))
      if (fixture === undefined) {
        return Effect.fail(new GitHubRepositoryUnavailableError(repository))
      }
      if (fixture.error !== undefined) {
        return Effect.fail(fixture.error)
      }

      return Effect.succeed(
        [...fixture.issues].sort((left, right) => left.number - right.number),
      )
    },
  })
}
