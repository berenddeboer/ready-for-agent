import { Effect, Layer } from "effect"
import {
  GitLabProjectUnavailableError,
  type GitLabRequestError,
} from "./errors.js"
import { GitLabService } from "./gitlab-service.js"
import type { GitLabReadyLabeledIssue, GitLabRepository } from "./types.js"

export interface GitLabServiceTestFixture {
  readonly repository: GitLabRepository
  readonly issues?: readonly GitLabReadyLabeledIssue[]
  readonly operatorLogin?: string
  readonly error?: GitLabRequestError
}

const key = (repository: GitLabRepository): string =>
  `${repository.forgeHost.toLowerCase()}/${repository.projectPath.toLowerCase()}`

export const makeGitLabServiceTest = (
  fixtures: readonly GitLabServiceTestFixture[],
): Layer.Layer<GitLabService> => {
  const byRepository = new Map(
    fixtures.map((fixture) => [key(fixture.repository), fixture]),
  )
  const fixtureFor = (repository: GitLabRepository) =>
    byRepository.get(key(repository))

  return Layer.succeed(GitLabService, {
    verifyProject: (repository) => {
      const fixture = fixtureFor(repository)
      if (fixture === undefined) {
        return Effect.fail(new GitLabProjectUnavailableError(repository))
      }
      return fixture.error === undefined
        ? Effect.void
        : Effect.fail(fixture.error)
    },
    getAuthenticatedUserLogin: (repository) => {
      const fixture = fixtureFor(repository)
      if (fixture === undefined) {
        return Effect.fail(new GitLabProjectUnavailableError(repository))
      }
      if (fixture.error !== undefined) return Effect.fail(fixture.error)
      return Effect.succeed(fixture.operatorLogin ?? "operator")
    },
    listReadyIssues: (repository) => {
      const fixture = fixtureFor(repository)
      if (fixture === undefined) {
        return Effect.fail(new GitLabProjectUnavailableError(repository))
      }
      if (fixture.error !== undefined) return Effect.fail(fixture.error)
      return Effect.succeed(
        [...(fixture.issues ?? [])].sort(
          (left, right) => left.number - right.number,
        ),
      )
    },
    hasCredentials: (repository) =>
      Effect.succeed(fixtureFor(repository) !== undefined),
  })
}
