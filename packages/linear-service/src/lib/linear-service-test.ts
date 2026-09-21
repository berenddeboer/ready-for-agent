import { Effect, Layer } from "effect"
import type { LinearRequestError } from "./errors.js"
import { LinearService } from "./linear-service.js"
import type {
  LinearIssueSnapshot,
  LinearProject,
  LinearReadyLabeledIssue,
  LinearTeamWorkflow,
} from "./types.js"

export const defaultLinearIssueSnapshot: LinearIssueSnapshot = {
  id: "linear-issue-1",
  identifier: "ENG-1",
  url: "https://linear.app/acme/issue/ENG-1",
  teamId: "team-eng",
  teamKey: "ENG",
  stateId: "todo",
  stateName: "Todo",
  stateType: "unstarted",
}

export interface LinearServiceTestFixture {
  readonly operatorLogin?: string
  readonly issues?: readonly LinearReadyLabeledIssue[]
  readonly projects?: readonly LinearProject[]
  readonly workflows?: Readonly<Record<string, readonly LinearTeamWorkflow[]>>
  readonly issue?: LinearIssueSnapshot
  readonly getIssue?: (
    nativeId: string,
  ) => Effect.Effect<LinearIssueSnapshot, LinearRequestError>
  readonly updateIssueState?: (
    nativeId: string,
    stateId: string,
  ) => Effect.Effect<void, LinearRequestError>
  readonly ensureMilestoneComment?: (
    nativeId: string,
    marker: string,
    body: string,
  ) => Effect.Effect<void, LinearRequestError>
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
    getIssue: (nativeId) =>
      fixture.getIssue !== undefined
        ? fixture.getIssue(nativeId)
        : failOr(() =>
            Effect.succeed(fixture.issue ?? defaultLinearIssueSnapshot),
          ),
    updateIssueState: (nativeId, stateId) =>
      fixture.updateIssueState !== undefined
        ? fixture.updateIssueState(nativeId, stateId)
        : failOr(() => Effect.void),
    ensureMilestoneComment: (nativeId, marker, body) =>
      fixture.ensureMilestoneComment !== undefined
        ? fixture.ensureMilestoneComment(nativeId, marker, body)
        : failOr(() => Effect.void),
    hasCredentials: () => Effect.succeed(fixture.hasCredentials ?? true),
    hasAmbientCredentials: () => Effect.succeed(fixture.hasCredentials ?? true),
  })
}

export const defaultLinearServiceShape = {
  getAuthenticatedUserLogin: () => Effect.succeed("linear-user"),
  listReadyIssues: () => Effect.succeed([]),
  listProjects: () => Effect.succeed([]),
  listProjectWorkflow: () => Effect.succeed([]),
  getIssue: () => Effect.succeed(defaultLinearIssueSnapshot),
  updateIssueState: () => Effect.void,
  ensureMilestoneComment: () => Effect.void,
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
}
