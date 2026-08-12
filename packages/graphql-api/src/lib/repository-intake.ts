import { Effect, Result } from "effect"
import type { ActiveAgentBackend } from "@ready-for-agent/agent-backend"
import {
  type DatabaseError,
  DbService,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import { classifyIntakeCandidates } from "@ready-for-agent/lifecycle-model"
import {
  type AgentBackendUnavailableError,
  type BuildModelNotConfiguredError,
  type IssueBlockedError,
  type IssueNotBlockedError,
  type IssueNotFoundError,
  type IssueNotOpenError,
  type ParentIssueError,
  type UnfinishedWorkItemExistsError,
  WorkItemLifecycle,
  type WorkItemRecord,
  isRetryableFailedWorkItem,
} from "@ready-for-agent/work-item-lifecycle"
import { preflightRepositoryIntake } from "./repository-intake-preflight.js"
import { toGraphQLError } from "./to-graphql-error.js"

export type RepositoryIntakeAction = "IMPLEMENT_NOW" | "QUEUE"

export type RepositoryIntakeIssueError = {
  readonly code: string
  readonly message: string
}

/** Discriminated Intake result for one Issue (GraphQL union payload). */
export type RepositoryIntakeIssueResult =
  | {
      readonly __typename: "RepositoryIntakeCreated"
      readonly issueNumber: number
      readonly title: string
      readonly url: string
      readonly action: RepositoryIntakeAction
      readonly workItem: WorkItemRecord
    }
  | {
      readonly __typename: "RepositoryIntakeFailed"
      readonly issueNumber: number
      readonly title: string
      readonly url: string
      readonly action: RepositoryIntakeAction
      readonly error: RepositoryIntakeIssueError
    }

export type RepositoryIntakeResult = {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
    readonly issuesReconciledAt: Date | null
  }
  readonly results: readonly RepositoryIntakeIssueResult[]
}

type CandidateLocalTag =
  | "IssueNotFoundError"
  | "IssueNotOpenError"
  | "ParentIssueError"
  | "IssueBlockedError"
  | "IssueNotBlockedError"
  | "UnfinishedWorkItemExistsError"

const isTagged = (
  error: unknown,
): error is { readonly _tag: string } & Record<string, unknown> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string"

/**
 * Candidate-local races become per-Issue failed results. Everything else
 * remains an operation-level failure that stops sequential Intake.
 */
export const isCandidateLocalIntakeError = (
  error: unknown,
): error is
  | IssueNotFoundError
  | IssueNotOpenError
  | ParentIssueError
  | IssueBlockedError
  | IssueNotBlockedError
  | UnfinishedWorkItemExistsError => {
  if (!isTagged(error)) {
    return false
  }
  switch (error._tag as CandidateLocalTag | string) {
    case "IssueNotFoundError":
    case "IssueNotOpenError":
    case "ParentIssueError":
    case "IssueBlockedError":
    case "IssueNotBlockedError":
    case "UnfinishedWorkItemExistsError":
      return true
    default:
      return false
  }
}

/**
 * Map a candidate-local tagged failure to the stable GraphQL error code/message
 * used for Implement Now / Queue domain errors (same `extensions.code` values).
 */
export const toCandidateLocalIntakeError = (
  error: unknown,
): RepositoryIntakeIssueError => {
  const graphQlError = toGraphQLError(error)
  const code =
    typeof graphQlError.extensions?.code === "string"
      ? graphQlError.extensions.code
      : "INTERNAL_SERVER_ERROR"
  return {
    code,
    message: graphQlError.message,
  }
}

/**
 * Synchronous best-effort Repository Intake:
 * 1. Resolve Repository
 * 2. Classify current candidates (no Refresh)
 * 3. Empty → successful no-op without preflight
 * 4. Nonempty → one shared preflight, then sequential Implement Now / Queue
 *
 * Candidate-local failures continue; infrastructure and unexpected defects fail
 * the Effect so GraphQL surfaces an operation-level error.
 */
export const startRepositoryIntake = (
  repositoryId: string,
): Effect.Effect<
  RepositoryIntakeResult,
  | RepositoryNotFoundError
  | AgentBackendUnavailableError
  | BuildModelNotConfiguredError
  | DatabaseError
  | unknown,
  DbService | WorkItemLifecycle | ActiveAgentBackend
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle

    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)
    if (repository === undefined) {
      return yield* new RepositoryNotFoundError({ repositoryId })
    }

    // Snapshot classification from the current Issue projection only.
    const [issues, workItems] = yield* Effect.all([
      db.listIssues(repository.id),
      lifecycle.listWorkItemsForRepository(repository.id),
    ])
    const candidates = classifyIntakeCandidates(
      issues,
      workItems.map((workItem) => ({
        issueNumber: workItem.issueNumber,
        id: workItem.id,
        state: workItem.state,
        canRetry: isRetryableFailedWorkItem(workItem),
      })),
    )

    if (candidates.length === 0) {
      return {
        repository,
        results: [],
      }
    }

    // Shared Repository preflight once before any Work Item is created.
    yield* preflightRepositoryIntake(repository.id)

    const results: RepositoryIntakeIssueResult[] = []

    for (const candidate of candidates) {
      // Widen error channel so Implement Now and Queue share one sequential path.
      const attempt: Effect.Effect<WorkItemRecord, unknown> =
        candidate.action === "IMPLEMENT_NOW"
          ? lifecycle.implementNow(repository.id, candidate.issueNumber)
          : lifecycle.queue(repository.id, candidate.issueNumber)

      // Capture candidate-local failures as result data; rethrow operation-level.
      const outcome = yield* Effect.result(attempt)
      if (Result.isSuccess(outcome)) {
        results.push({
          __typename: "RepositoryIntakeCreated",
          issueNumber: candidate.issueNumber,
          title: candidate.title,
          url: candidate.url,
          action: candidate.action,
          workItem: outcome.success,
        })
        continue
      }

      const failure = outcome.failure
      if (isCandidateLocalIntakeError(failure)) {
        results.push({
          __typename: "RepositoryIntakeFailed",
          issueNumber: candidate.issueNumber,
          title: candidate.title,
          url: candidate.url,
          action: candidate.action,
          error: toCandidateLocalIntakeError(failure),
        })
        continue
      }

      // Operation-level: stop processing; earlier Work Items already committed.
      return yield* Effect.fail(failure)
    }

    return {
      repository,
      results,
    }
  })
