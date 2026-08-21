import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  type AzureDevOpsNotImplementedError,
  type AzureDevOpsProjectUnavailableError,
  type AzureDevOpsRequestError,
  AzureDevOpsService,
} from "@ready-for-agent/azure-devops-service"
import {
  type DatabaseError,
  DbService,
  type IssueRecord,
  type RepositoryNotFoundError,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  type GitHubOperationOptions,
  type GitHubRepositoryUnavailableError,
  type GitHubRequestError,
  GitHubService,
  type GitHubThrottledError,
  type GitHubTlsTrustError,
  type ReadyLabeledIssue,
} from "@ready-for-agent/github-service"
import {
  type GitLabProjectUnavailableError,
  type GitLabRequestError,
  GitLabService,
} from "@ready-for-agent/gitlab-service"
import {
  classifyActiveClosingPullRequests,
  competingPullRequestIdentity,
  evaluateRelevantIssue,
  workItemBranchName,
} from "@ready-for-agent/lifecycle-model"

export const CompetingPullRequestIdentity = Schema.Struct({
  repository: Schema.String,
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type CompetingPullRequestIdentity =
  typeof CompetingPullRequestIdentity.Type

export const CompetingIssueClosingPullRequestObservation = Schema.Struct({
  issueNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  identities: Schema.Array(CompetingPullRequestIdentity),
})
export type CompetingIssueClosingPullRequestObservation =
  typeof CompetingIssueClosingPullRequestObservation.Type

export const ReconciliationSummary = Schema.Struct({
  fetched: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  inserted: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  updated: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  deleted: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  unchanged: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  competingObservations: Schema.Array(
    CompetingIssueClosingPullRequestObservation,
  ),
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
    issueNumber: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    ),
    progress: ReconciliationSummary,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ReconciliationError =
  | GitHubRepositoryUnavailableError
  | GitHubRequestError
  | GitHubTlsTrustError
  | GitHubThrottledError
  | GitLabProjectUnavailableError
  | GitLabRequestError
  | AzureDevOpsProjectUnavailableError
  | AzureDevOpsRequestError
  | AzureDevOpsNotImplementedError
  | ReconciliationMutationError
  | RepositoryNotFoundError
  | DatabaseError

export interface ReconciliationOptions {
  /** Semantic source for GitHub reads made during reconciliation. */
  readonly githubOperation?: GitHubOperationOptions
}

export interface IssueReconcilerShape {
  readonly reconcile: (
    repository: RepositoryRecord,
    options?: ReconciliationOptions,
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
  local.issueAuthor === remote.author &&
  local.hasChildren === remote.hasChildren &&
  local.parentPosition === remote.parentPosition &&
  local.parent?.issueNumber === remote.parent?.number &&
  local.parent?.issueUrl === remote.parent?.url &&
  local.blockedBy.length === remote.blockedBy.length &&
  local.blockedBy.every((dependency) =>
    remote.blockedBy.some(
      (remoteDependency) =>
        dependency.issueNumber === remoteDependency.number &&
        dependency.issueUrl === remoteDependency.url,
    ),
  )

export const IssueReconcilerLive = Layer.effect(
  IssueReconciler,
  Effect.gen(function* () {
    const db = yield* DbService
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azureDevOps = yield* AzureDevOpsService

    const reconcile = Effect.fn("IssueReconciler.reconcile")(function* (
      repository: RepositoryRecord,
      options?: ReconciliationOptions,
    ) {
      const forgeRepository = {
        forge: repository.forge,
        forgeHost: repository.forgeHost,
        projectPath: repository.projectPath,
      }
      const localIssues = yield* db.listIssues(repository.id)

      const fetchRemote = (() => {
        switch (repository.forge) {
          case "gitlab":
            return Effect.gen(function* () {
              const authorScope = repository.includeAllIssueAuthors
                ? ({ includeAll: true } as const)
                : ({
                    includeAll: false,
                    operatorLogin:
                      yield* gitlab.getAuthenticatedUserLogin(forgeRepository),
                  } as const)
              const remoteIssues =
                yield* gitlab.listReadyIssues(forgeRepository)
              return { authorScope, remoteIssues }
            })
          case "azure-devops":
            return Effect.gen(function* () {
              const authorScope = repository.includeAllIssueAuthors
                ? ({ includeAll: true } as const)
                : ({
                    includeAll: false,
                    operatorLogin:
                      yield* azureDevOps.getAuthenticatedUserLogin(
                        forgeRepository,
                      ),
                  } as const)
              const remoteIssues =
                yield* azureDevOps.listReadyIssues(forgeRepository)
              return { authorScope, remoteIssues }
            })
          case "github":
            return Effect.gen(function* () {
              // An authenticated GitHub list may refresh a stale credential.
              // Resolve the operator afterwards so author scoping uses that
              // credential's identity for this reconciliation.
              const remoteIssues = yield* github.listReadyIssues(
                forgeRepository,
                options?.githubOperation,
              )
              const authorScope = repository.includeAllIssueAuthors
                ? ({ includeAll: true } as const)
                : ({
                    includeAll: false,
                    operatorLogin: yield* github.getAuthenticatedUserLogin(
                      forgeRepository,
                      options?.githubOperation,
                    ),
                  } as const)
              return { authorScope, remoteIssues }
            })
          default: {
            const _exhaustive: never = repository.forge
            return Effect.die(_exhaustive)
          }
        }
      })()
      const { authorScope, remoteIssues } = yield* fetchRemote
      const repositoryName = repository.projectPath.toLowerCase()
      const workItemPullRequests = yield* db.listWorkItemPullRequests(
        repository.id,
      )
      const unfinishedCreatePrWorkItems =
        yield* db.listUnfinishedCreatePrWorkItems(repository.id)

      const localByNumber = new Map(
        localIssues.map((issue) => [issue.issueNumber, issue]),
      )
      const workItemPullRequestsByIssue = new Map<number, Set<number>>()
      for (const workItemPullRequest of workItemPullRequests) {
        const numbers =
          workItemPullRequestsByIssue.get(workItemPullRequest.issueNumber) ??
          new Set<number>()
        numbers.add(workItemPullRequest.pullRequestNumber)
        workItemPullRequestsByIssue.set(
          workItemPullRequest.issueNumber,
          numbers,
        )
      }
      const pendingSelfByIssue = new Map<
        number,
        {
          readonly branch: string
          readonly sourceRepository: string
        }[]
      >()
      for (const workItem of unfinishedCreatePrWorkItems) {
        const pending = pendingSelfByIssue.get(workItem.issueNumber) ?? []
        pending.push({
          branch: workItemBranchName({
            projectPath: repository.projectPath,
            issueNumber: workItem.issueNumber,
            workItemId: workItem.workItemId,
          }),
          sourceRepository: repository.projectPath,
        })
        pendingSelfByIssue.set(workItem.issueNumber, pending)
      }
      const competingObservations: CompetingIssueClosingPullRequestObservation[] =
        []
      const remoteByNumber = new Map(
        remoteIssues
          .filter((issue) => {
            const context = {
              forge: repository.forge,
              repositoryName,
              workItemPullRequestNumbers:
                workItemPullRequestsByIssue.get(issue.number) ?? new Set(),
              pendingSelfOwnership: pendingSelfByIssue.get(issue.number) ?? [],
              authorScope,
            }
            const classification = classifyActiveClosingPullRequests(
              issue,
              context,
            )
            if (classification.competing.length > 0) {
              const identities = [
                ...new Map(
                  classification.competing.map((pullRequest) => [
                    competingPullRequestIdentity(pullRequest),
                    {
                      repository: pullRequest.repository,
                      number: pullRequest.number,
                    },
                  ]),
                ).values(),
              ].sort((left, right) =>
                competingPullRequestIdentity(left).localeCompare(
                  competingPullRequestIdentity(right),
                ),
              )
              competingObservations.push({
                issueNumber: issue.number,
                identities,
              })
            }
            return evaluateRelevantIssue(issue, context)._tag === "match"
          })
          .map((issue) => [issue.number, issue]),
      )
      competingObservations.sort(
        (left, right) => left.issueNumber - right.issueNumber,
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
        .filter((issue) => !remoteByNumber.has(issue.issueNumber))
        .sort((left, right) => left.issueNumber - right.issueNumber)

      const progress = {
        fetched: remoteIssues.length,
        inserted: 0,
        updated: 0,
        deleted: 0,
        unchanged: authoritativeIssues.length - upserts.length,
        competingObservations,
      }

      const mutationError = (
        operation: ReconciliationMutation,
        cause: unknown,
        issueNumber?: number,
      ) =>
        new ReconciliationMutationError({
          repositoryId: repository.id,
          operation,
          ...(issueNumber === undefined ? {} : { issueNumber }),
          progress: { ...progress },
          cause,
        })

      for (const { operation, issue } of upserts) {
        yield* db
          .storeIssue({
            repositoryId: repository.id,
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            githubCreatedAt: issue.createdAt,
            issueAuthor: issue.author,
            parentPosition: issue.parentPosition,
            hasChildren: issue.hasChildren,
            parent:
              issue.parent === null
                ? null
                : {
                    issueNumber: issue.parent.number,
                    issueUrl: issue.parent.url,
                  },
            blockedBy: issue.blockedBy.map((dependency) => ({
              issueNumber: dependency.number,
              issueUrl: dependency.url,
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
          .deleteIssue(repository.id, issue.issueNumber)
          .pipe(
            Effect.mapError((cause) =>
              mutationError("delete", cause, issue.issueNumber),
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
