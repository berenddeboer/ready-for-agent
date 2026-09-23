import { Effect, Layer } from "effect"
import type { FpRequestError } from "./errors.js"
import { FpService } from "./fp-service.js"
import type {
  FpIssue,
  FpIssueSnapshot,
  FpProjectOptions,
  FpReadiness,
} from "./types.js"

export const defaultFpIssueSnapshot: FpIssueSnapshot = {
  nativeId: "abcdefghijklmnopqrstuvwxyzabcdef",
  displayId: "FP-abcdefgh",
  url: "fp://issue?workspace=ws-test&project=proj-test&id=abcdefghijklmnopqrstuvwxyzabcdef",
  status: "todo",
  state: "OPEN",
  labels: ["ready-for-agent"],
}

export interface FpServiceTestFixture {
  readonly operatorLogin?: string
  readonly issues?: readonly FpIssue[]
  readonly issue?: FpIssueSnapshot
  readonly getIssue?: (
    options: FpProjectOptions,
    issueId: string,
  ) => Effect.Effect<FpIssueSnapshot, FpRequestError>
  readonly readiness?: FpReadiness
  readonly error?: FpRequestError
}

/** In-memory stand-in for lifecycle and reconciler tests. */
export const makeFpServiceTest = (
  fixture: FpServiceTestFixture = {},
): Layer.Layer<FpService> => {
  const failOr = <A>(succeed: () => Effect.Effect<A, never>) => {
    if (fixture.error !== undefined) {
      return Effect.fail(fixture.error)
    }
    return succeed()
  }
  return Layer.succeed(FpService, {
    getAuthenticatedUserLogin: () =>
      failOr(() =>
        Effect.succeed(fixture.operatorLogin ?? "fp-user@example.com"),
      ),
    listReadyIssues: () =>
      failOr(() => Effect.succeed([...(fixture.issues ?? [])])),
    getIssue: (options, issueId) =>
      fixture.getIssue !== undefined
        ? fixture.getIssue(options, issueId)
        : failOr(() => Effect.succeed(fixture.issue ?? defaultFpIssueSnapshot)),
    checkReadiness: () =>
      Effect.succeed(
        fixture.readiness ?? {
          _tag: "ready",
          version: "0.25.0",
          remote: { workspaceSlug: "ws-test", projectId: "proj-test" },
        },
      ),
  })
}
