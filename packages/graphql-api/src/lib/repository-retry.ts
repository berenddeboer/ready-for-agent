import { Effect, Result, Schema } from "effect"
import {
  type DatabaseError,
  DbService,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import { evaluateUnfinishedWorkItem } from "@ready-for-agent/lifecycle-model"
import {
  type ActiveStepRunExistsError,
  type RetryNotEligibleError,
  WorkItemLifecycle,
  type WorkItemRecord,
  type WorkItemTerminalError,
  isRetryableFailedWorkItem,
} from "@ready-for-agent/work-item-lifecycle"
import { toGraphQLError } from "./to-graphql-error.js"
import { workItemCanRetry } from "./work-item-projection.js"

export type RetryWorkItemsSelectorInput = {
  readonly issueNumber?: number | null
  readonly workItemId?: string | null
  readonly allRetryable?: boolean | null
}

export type RetryWorkItemsSelector =
  | { readonly kind: "issue"; readonly issueNumber: number }
  | { readonly kind: "work-item"; readonly workItemId: string }
  | { readonly kind: "all-retryable" }

export type RetryWorkItemsItemError = {
  readonly code: string
  readonly message: string
}

/** Discriminated Retry result for one Work Item (GraphQL union payload). */
export type RetryWorkItemsItemResult =
  | {
      readonly __typename: "RetryWorkItemsRetried"
      readonly issueNumber: number
      readonly workItem: WorkItemRecord
    }
  | {
      readonly __typename: "RetryWorkItemsSkipped"
      readonly issueNumber: number
      readonly workItem: WorkItemRecord
      readonly reason: RetryWorkItemsItemError
    }
  | {
      readonly __typename: "RetryWorkItemsFailed"
      readonly issueNumber: number
      readonly workItem: WorkItemRecord
      readonly error: RetryWorkItemsItemError
    }

export type RetryWorkItemsResult = {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
    readonly issuesReconciledAt: Date | null
  }
  readonly results: readonly RetryWorkItemsItemResult[]
}

export class InvalidRetrySelectorError extends Schema.TaggedErrorClass<InvalidRetrySelectorError>()(
  "InvalidRetrySelectorError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class WorkItemNotInRepositoryError extends Schema.TaggedErrorClass<WorkItemNotInRepositoryError>()(
  "WorkItemNotInRepositoryError",
  {
    workItemId: Schema.String,
    repositoryId: Schema.String,
  },
) {}

export class NoUnfinishedWorkItemError extends Schema.TaggedErrorClass<NoUnfinishedWorkItemError>()(
  "NoUnfinishedWorkItemError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

const isTagged = (
  error: unknown,
): error is { readonly _tag: string } & Record<string, unknown> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string"

const compareRetryTargets = (
  left: WorkItemRecord,
  right: WorkItemRecord,
): number =>
  left.issueNumber - right.issueNumber || left.id.localeCompare(right.id)

const isUnfinishedWorkItem = (workItem: WorkItemRecord): boolean =>
  evaluateUnfinishedWorkItem({
    id: workItem.id,
    state: workItem.state,
    canRetry: isRetryableFailedWorkItem(workItem),
  })._tag === "match"

export const parseRetryWorkItemsSelector = (
  input: RetryWorkItemsSelectorInput,
): RetryWorkItemsSelector | InvalidRetrySelectorError => {
  const issueNumber = input.issueNumber
  const workItemId =
    typeof input.workItemId === "string" ? input.workItemId.trim() : ""
  const hasIssue = issueNumber !== null && issueNumber !== undefined
  const hasWorkItem = workItemId.length > 0
  const hasAllRetryable = input.allRetryable === true
  const selectedCount =
    Number(hasIssue) + Number(hasWorkItem) + Number(hasAllRetryable)

  if (selectedCount !== 1) {
    return new InvalidRetrySelectorError({
      reason: "exactly_one_selector",
      message:
        "Exactly one of issueNumber, workItemId, or allRetryable=true is required",
    })
  }

  if (hasIssue) {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      return new InvalidRetrySelectorError({
        reason: "invalid_issue_number",
        message: "issueNumber must be a positive integer",
      })
    }
    return { kind: "issue", issueNumber }
  }

  if (hasWorkItem) {
    return { kind: "work-item", workItemId }
  }

  return { kind: "all-retryable" }
}

export const snapshotRetryTargets = (input: {
  readonly selector: RetryWorkItemsSelector
  readonly repositoryId: string
  readonly workItems: readonly WorkItemRecord[]
}):
  | readonly WorkItemRecord[]
  | WorkItemNotInRepositoryError
  | NoUnfinishedWorkItemError => {
  const selector = input.selector
  switch (selector.kind) {
    case "all-retryable":
      return input.workItems
        .filter((workItem) => workItemCanRetry(workItem))
        .slice()
        .sort(compareRetryTargets)
    case "work-item": {
      const workItem = input.workItems.find(
        (candidate) => candidate.id === selector.workItemId,
      )
      if (workItem === undefined) {
        // Presence is resolved by getWorkItem; this path is a repo mismatch
        // when the Work Item exists elsewhere, or a missing row after load.
        return new WorkItemNotInRepositoryError({
          workItemId: selector.workItemId,
          repositoryId: input.repositoryId,
        })
      }
      if (workItem.repositoryId !== input.repositoryId) {
        return new WorkItemNotInRepositoryError({
          workItemId: workItem.id,
          repositoryId: input.repositoryId,
        })
      }
      return [workItem]
    }
    case "issue": {
      const unfinished = input.workItems
        .filter(
          (workItem) =>
            workItem.issueNumber === selector.issueNumber &&
            isUnfinishedWorkItem(workItem),
        )
        .slice()
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id),
        )
      const current = unfinished[0]
      if (current === undefined) {
        return new NoUnfinishedWorkItemError({
          repositoryId: input.repositoryId,
          issueNumber: selector.issueNumber,
        })
      }
      return [current]
    }
    default: {
      const _exhaustive: never = selector
      return _exhaustive
    }
  }
}

type ItemLocalRetryTag =
  | "RetryNotEligibleError"
  | "WorkItemTerminalError"
  | "ActiveStepRunExistsError"
  | "WorkItemNotFoundError"

/**
 * Per-item Retry races continue the sequence. Infrastructure and unexpected
 * defects remain operation-level and stop processing.
 */
export const isItemLocalRetryError = (
  error: unknown,
): error is
  | RetryNotEligibleError
  | WorkItemTerminalError
  | ActiveStepRunExistsError
  | { readonly _tag: "WorkItemNotFoundError" } => {
  if (!isTagged(error)) {
    return false
  }
  switch (error._tag as ItemLocalRetryTag | string) {
    case "RetryNotEligibleError":
    case "WorkItemTerminalError":
    case "ActiveStepRunExistsError":
    case "WorkItemNotFoundError":
      return true
    default:
      return false
  }
}

export const toRetryItemError = (error: unknown): RetryWorkItemsItemError => {
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

const isSkippedRetryError = (error: unknown): boolean => {
  if (!isTagged(error)) {
    return false
  }
  return (
    error._tag === "RetryNotEligibleError" ||
    error._tag === "WorkItemTerminalError"
  )
}

/**
 * Synchronous best-effort Repository Retry:
 * 1. Resolve Repository
 * 2. Validate exactly one selector
 * 3. Snapshot accepted targets (canRetry, unfinished Issue WI, or one WI)
 * 4. Empty --all-retryable → successful no-op
 * 5. Sequential ordinary Work Item Retry
 *
 * Ineligible races and concurrent active-run conflicts become result data;
 * infrastructure and unexpected defects fail the Effect.
 */
export const retryWorkItems = (
  repositoryId: string,
  selectorInput: RetryWorkItemsSelectorInput,
): Effect.Effect<
  RetryWorkItemsResult,
  | RepositoryNotFoundError
  | InvalidRetrySelectorError
  | WorkItemNotInRepositoryError
  | NoUnfinishedWorkItemError
  | DatabaseError
  | unknown,
  DbService | WorkItemLifecycle
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle

    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)
    if (repository === undefined) {
      return yield* new RepositoryNotFoundError({ repositoryId })
    }

    const selector = parseRetryWorkItemsSelector(selectorInput)
    if (selector instanceof InvalidRetrySelectorError) {
      return yield* selector
    }

    const workItems =
      selector.kind === "work-item"
        ? yield* lifecycle
            .getWorkItem(selector.workItemId)
            .pipe(Effect.map((workItem) => [workItem] as const))
        : selector.kind === "issue"
          ? yield* lifecycle.listWorkItemsForIssue(
              repository.id,
              selector.issueNumber,
            )
          : yield* lifecycle.listWorkItemsForRepository(repository.id)

    const snapshot = snapshotRetryTargets({
      selector,
      repositoryId: repository.id,
      workItems,
    })
    if (
      snapshot instanceof WorkItemNotInRepositoryError ||
      snapshot instanceof NoUnfinishedWorkItemError
    ) {
      return yield* snapshot
    }

    if (snapshot.length === 0) {
      return {
        repository,
        results: [],
      }
    }

    const results: RetryWorkItemsItemResult[] = []

    for (const target of snapshot) {
      const outcome = yield* Effect.result(lifecycle.retry(target.id))
      if (Result.isSuccess(outcome)) {
        results.push({
          __typename: "RetryWorkItemsRetried",
          issueNumber: outcome.success.issueNumber,
          workItem: outcome.success,
        })
        continue
      }

      const failure = outcome.failure
      if (isItemLocalRetryError(failure)) {
        const mapped = toRetryItemError(failure)
        if (isSkippedRetryError(failure)) {
          results.push({
            __typename: "RetryWorkItemsSkipped",
            issueNumber: target.issueNumber,
            workItem: target,
            reason: mapped,
          })
          continue
        }
        results.push({
          __typename: "RetryWorkItemsFailed",
          issueNumber: target.issueNumber,
          workItem: target,
          error: mapped,
        })
        continue
      }

      const operationFailure: unknown = failure
      return yield* Effect.fail(operationFailure)
    }

    return {
      repository,
      results,
    }
  })
