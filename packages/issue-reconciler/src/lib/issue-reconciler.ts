import { Clock, Context, Data, Effect, Layer } from "effect"
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

export interface ReconciliationSummary {
  readonly fetched: number
  readonly inserted: number
  readonly updated: number
  readonly deleted: number
  readonly unchanged: number
}

export type ReconciliationMutation =
  | "insert"
  | "update"
  | "delete"
  | "record-success"

export class ReconciliationMutationError extends Data.TaggedError(
  "ReconciliationMutationError",
)<{
  readonly repositoryId: string
  readonly operation: ReconciliationMutation
  readonly githubIssueNumber?: number
  readonly progress: ReconciliationSummary
  readonly cause: unknown
}> {}

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

const isRelevant = (issue: ReadyLabeledIssue): boolean =>
  issue.hierarchySupported &&
  (issue.parent === null
    ? issue.state === "OPEN"
    : issue.parent.state === "OPEN" && issue.parent.isReadyLabeled)

export const IssueReconcilerLive = Layer.effect(
  IssueReconciler,
  Effect.gen(function* () {
    const db = yield* DbService
    const github = yield* GitHubService

    const reconcile = Effect.fn("IssueReconciler.reconcile")(function* (
      repository: RepositoryRecord,
    ) {
      const localIssues = yield* db.listIssues(repository.id)
      const remoteIssues = yield* github.listReadyIssues({
        owner: repository.githubOwner,
        name: repository.githubRepo,
      })

      const localByNumber = new Map(
        localIssues.map((issue) => [issue.githubIssueNumber, issue]),
      )
      const remoteByNumber = new Map(
        remoteIssues.filter(isRelevant).map((issue) => [issue.number, issue]),
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
