import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  type DatabaseError,
  DbService,
  type IssueRecord,
  type RepositoryNotFoundError,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  type GitHubRepositoryUnavailableError,
  type GitHubRequestError,
  GitHubService,
  type ReadyLabeledIssue,
} from "@ready-for-agent/github-service"

export const ReconciliationSummary = Schema.Struct({
  fetched: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  inserted: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  updated: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  deleted: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  unchanged: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ReconciliationSummary = typeof ReconciliationSummary.Type

export const ReconciliationMutation = Schema.Literals([
  "insert",
  "update",
  "delete",
  "record-success",
])
export type ReconciliationMutation = typeof ReconciliationMutation.Type

export class ReconciliationMutationError extends Schema.TaggedErrorClass<ReconciliationMutationError>()(
  "ReconciliationMutationError",
  {
    repositoryId: Schema.String,
    operation: ReconciliationMutation,
    githubIssueNumber: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    ),
    progress: ReconciliationSummary,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ReconciliationError =
  | GitHubRepositoryUnavailableError
  | GitHubRequestError
  | ReconciliationMutationError
  | RepositoryNotFoundError
  | DatabaseError

export interface IssueReconcilerShape {
  readonly reconcile: (
    repository: RepositoryRecord,
  ) => Effect.Effect<ReconciliationSummary, ReconciliationError>
}

export class IssueReconciler extends Context.Service<
  IssueReconciler,
  IssueReconcilerShape
>()("@ready-for-agent/issue-reconciler/IssueReconciler") {}

const matches = (local: IssueRecord, remote: ReadyLabeledIssue): boolean =>
  local.title === remote.title &&
  local.body === remote.body &&
  local.url === remote.url &&
  local.state === remote.state &&
  local.githubCreatedAt.getTime() === remote.createdAt.getTime() &&
  local.hasChildren === remote.hasChildren &&
  local.parentPosition === remote.parentPosition &&
  local.parent?.githubIssueNumber === remote.parent?.number &&
  local.parent?.githubIssueUrl === remote.parent?.url &&
  local.blockedBy.length === remote.blockedBy.length &&
  local.blockedBy.every((dependency) =>
    remote.blockedBy.some(
      (remoteDependency) =>
        dependency.githubIssueNumber === remoteDependency.number &&
        dependency.githubIssueUrl === remoteDependency.url,
    ),
  )

const isActiveClosingPullRequest = (
  pullRequest: ReadyLabeledIssue["closingPullRequests"][number],
): boolean =>
  pullRequest.state === "MERGED" ||
  (pullRequest.state === "OPEN" && !pullRequest.isDraft)

const isRelevant = (
  issue: ReadyLabeledIssue,
  repositoryName: string,
  workItemPullRequestNumbers: ReadonlySet<number>,
): boolean => {
  const activeClosingPullRequests = issue.closingPullRequests.filter(
    isActiveClosingPullRequest,
  )
  return (
    issue.hierarchySupported &&
    (issue.parent === null
      ? issue.state === "OPEN"
      : issue.parent.state === "OPEN" && issue.parent.isReadyLabeled) &&
    (activeClosingPullRequests.length === 0 ||
      activeClosingPullRequests.some(
        (pullRequest) =>
          pullRequest.repository.toLowerCase() === repositoryName &&
          workItemPullRequestNumbers.has(pullRequest.number),
      ))
  )
}

export const IssueReconcilerLive = Layer.effect(
  IssueReconciler,
  Effect.gen(function* () {
    const db = yield* DbService
    const github = yield* GitHubService

    const reconcile = Effect.fn("IssueReconciler.reconcile")(function* (
      repository: RepositoryRecord,
    ) {
      const localIssues = yield* db.listIssues(repository.id)
      const workItemPullRequests = yield* db.listWorkItemPullRequests(
        repository.id,
      )
      const remoteIssues = yield* github.listReadyIssues({
        owner: repository.githubOwner,
        name: repository.githubRepo,
      })
      const repositoryName =
        `${repository.githubOwner}/${repository.githubRepo}`.toLowerCase()

      const localByNumber = new Map(
        localIssues.map((issue) => [issue.githubIssueNumber, issue]),
      )
      const workItemPullRequestsByIssue = new Map<number, Set<number>>()
      for (const workItemPullRequest of workItemPullRequests) {
        const numbers =
          workItemPullRequestsByIssue.get(
            workItemPullRequest.githubIssueNumber,
          ) ?? new Set<number>()
        numbers.add(workItemPullRequest.githubPullRequestNumber)
        workItemPullRequestsByIssue.set(
          workItemPullRequest.githubIssueNumber,
          numbers,
        )
      }
      const remoteByNumber = new Map(
        remoteIssues
          .filter((issue) =>
            isRelevant(
              issue,
              repositoryName,
              workItemPullRequestsByIssue.get(issue.number) ?? new Set(),
            ),
          )
          .map((issue) => [issue.number, issue]),
      )
      const authoritativeIssues = [...remoteByNumber.values()]
      const upserts = authoritativeIssues
        .map((issue) => {
          const local = localByNumber.get(issue.number)
          if (!local) {
            return { operation: "insert" as const, issue }
          }
          if (!matches(local, issue)) {
            return { operation: "update" as const, issue }
          }
          return undefined
        })
        .filter((entry) => entry !== undefined)
        .sort((left, right) => left.issue.number - right.issue.number)
      const deletions = localIssues
        .filter((issue) => !remoteByNumber.has(issue.githubIssueNumber))
        .sort((left, right) => left.githubIssueNumber - right.githubIssueNumber)

      const progress = {
        fetched: remoteIssues.length,
        inserted: 0,
        updated: 0,
        deleted: 0,
        unchanged: authoritativeIssues.length - upserts.length,
      }

      const mutationError = (
        operation: ReconciliationMutation,
        cause: unknown,
        githubIssueNumber?: number,
      ) =>
        new ReconciliationMutationError({
          repositoryId: repository.id,
          operation,
          ...(githubIssueNumber === undefined ? {} : { githubIssueNumber }),
          progress: { ...progress },
          cause,
        })

      for (const { operation, issue } of upserts) {
        yield* db
          .storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            githubCreatedAt: issue.createdAt,
            parentPosition: issue.parentPosition,
            hasChildren: issue.hasChildren,
            parent:
              issue.parent === null
                ? null
                : {
                    githubIssueNumber: issue.parent.number,
                    githubIssueUrl: issue.parent.url,
                  },
            blockedBy: issue.blockedBy.map((dependency) => ({
              githubIssueNumber: dependency.number,
              githubIssueUrl: dependency.url,
            })),
          })
          .pipe(
            Effect.mapError((cause) =>
              mutationError(operation, cause, issue.number),
            ),
          )
        if (operation === "insert") {
          progress.inserted += 1
        } else {
          progress.updated += 1
        }
      }

      for (const issue of deletions) {
        yield* db
          .deleteIssue(repository.id, issue.githubIssueNumber)
          .pipe(
            Effect.mapError((cause) =>
              mutationError("delete", cause, issue.githubIssueNumber),
            ),
          )
        progress.deleted += 1
      }

      const reconciledAt = new Date(yield* Clock.currentTimeMillis)
      yield* db
        .markIssuesReconciled(repository.id, reconciledAt)
        .pipe(
          Effect.mapError((cause) => mutationError("record-success", cause)),
        )

      return progress
    })

    return IssueReconciler.of({ reconcile })
  }),
)
