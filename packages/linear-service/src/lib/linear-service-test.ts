import { Effect, Layer } from "effect"
import type { LinearRequestError } from "./errors.js"
import { LinearService } from "./linear-service.js"
import type {
  LinearProject,
  LinearReadyLabeledIssue,
  LinearTeamWorkflow,
} from "./types.js"

export interface LinearServiceTestFixture {
  readonly operatorLogin?: string
  readonly issues?: readonly LinearReadyLabeledIssue[]
  readonly projects?: readonly LinearProject[]
  readonly workflows?: Readonly<Record<string, readonly LinearTeamWorkflow[]>>
  readonly hasCredentials?: boolean
  readonly error?: LinearRequestError
}

export const makeLinearServiceTest = (
  fixture: LinearServiceTestFixture = {},
): Layer.Layer<LinearService> => {
  const failOr = <A>(succeed: () => Effect.Effect<A, never>) => {
    if (fixture.error !== undefined) {
      return Effect.fail(fixture.error)
    }
    return succeed()
  }

  return Layer.succeed(LinearService, {
    getAuthenticatedUserLogin: () =>
      failOr(() => Effect.succeed(fixture.operatorLogin ?? "linear-user")),
    listReadyIssues: () =>
      failOr(() => Effect.succeed([...(fixture.issues ?? [])])),
    listProjects: () =>
      failOr(() => Effect.succeed([...(fixture.projects ?? [])])),
    listProjectWorkflow: (projectId) =>
      failOr(() => Effect.succeed([...(fixture.workflows?.[projectId] ?? [])])),
    hasCredentials: () => Effect.succeed(fixture.hasCredentials ?? true),
    hasAmbientCredentials: () => Effect.succeed(fixture.hasCredentials ?? true),
  })
}

export const defaultLinearServiceShape = {
  getAuthenticatedUserLogin: () => Effect.succeed("linear-user"),
  listReadyIssues: () => Effect.succeed([]),
  listProjects: () => Effect.succeed([]),
  listProjectWorkflow: () => Effect.succeed([]),
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
}
