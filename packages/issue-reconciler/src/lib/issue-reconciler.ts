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
  type ReadyLabeledIssue,
  resolveForgeIssueOperations,
} from "@ready-for-agent/forge-contract"
import {
  type GitHubOperationOptions,
  type GitHubRepositoryUnavailableError,
  type GitHubRequestError,
  GitHubService,
  type GitHubThrottledError,
  type GitHubTlsTrustError,
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
  isForge,
  persistedIssueIdentity,
  relevantIssuePredicateContext,
  workItemBranchName,
} from "@ready-for-agent/lifecycle-model"
import {
  LinearNotConfiguredError,
  type LinearRequestError,
  LinearService,
} from "@ready-for-agent/linear-service"

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
  | LinearRequestError
  | LinearNotConfiguredError
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

const remoteIdentity = (remote: ReadyLabeledIssue) => ({
  nativeId: remote.nativeId,
  displayId: remote.displayId,
})

const referenceIdentity = (reference: {
  readonly number: number
  readonly nativeId: string
  readonly displayId: string
}) => ({
  nativeId: reference.nativeId,
  displayId: reference.displayId,
})

const matches = (
  local: IssueRecord,
  remote: ReadyLabeledIssue,
  issueTracker: IssueRecord["issueTracker"],
): boolean => {
  const identity = remoteIdentity(remote)
  const parentIdentity =
    remote.parent === null ? null : referenceIdentity(remote.parent)
  return (
    local.issueTracker === issueTracker &&
    local.nativeId === identity.nativeId &&
    local.displayId === identity.displayId &&
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
    local.parent?.nativeId === parentIdentity?.nativeId &&
    local.blockedBy.length === remote.blockedBy.length &&
    local.blockedBy.every((dependency) =>
      remote.blockedBy.some((remoteDependency) => {
        const blockingIdentity = referenceIdentity(remoteDependency)
        return (
          dependency.issueUrl === remoteDependency.url &&
          dependency.nativeId === blockingIdentity.nativeId
        )
      }),
    )
  )
}

export const IssueReconcilerLive = Layer.effect(
  IssueReconciler,
  Effect.gen(function* () {
    const db = yield* DbService
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azureDevOps = yield* AzureDevOpsService
    const linear = yield* LinearService

    const reconcile = Effect.fn("IssueReconciler.reconcile")(function* (
      repository: RepositoryRecord,
      options?: ReconciliationOptions,
    ) {
      const issueTracker = repository.issueTracker
      const localIssues = yield* db.listIssues(repository.id)
      const { authorScope, remoteIssues } = yield* (() => {
        if (issueTracker === "linear") {
          return Effect.gen(function* () {
            const projectId = repository.linearProjectId?.trim() ?? ""
            if (projectId === "") {
              return yield* new LinearNotConfiguredError({
                repositoryId: repository.id,
                message:
                  "Select a Linear project in Repository settings before refreshing Issues",
              })
            }
            if (repository.includeAllIssueAuthors) {
              const issues = yield* linear.listReadyIssues(projectId)
              return {
                remoteIssues: issues,
                authorScope: { includeAll: true as const },
              }
            }
            const operatorLogin = yield* linear.getAuthenticatedUserLogin()
            const issues = yield* linear.listReadyIssues(projectId)
            return {
              remoteIssues: issues,
              authorScope: {
                includeAll: false as const,
                operatorLogin,
              },
            }
          })
        }
        if (!isForge(issueTracker)) {
          return Effect.fail(
            new LinearNotConfiguredError({
              repositoryId: repository.id,
              message: `Issue Tracker ${issueTracker} is not supported for discovery`,
            }),
          )
        }
        const forgeRepository = {
          forge: issueTracker,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
        }
        const issueOperations = resolveForgeIssueOperations(
          issueTracker,
          { github, gitlab, azureDevOps },
          options?.githubOperation,
        )
        return issueOperations.listReadyIssuesWithAuthorScope(
          forgeRepository,
          repository.includeAllIssueAuthors,
        )
      })()
      const repositoryName = repository.projectPath.toLowerCase()
      const workItemPullRequests = yield* db.listWorkItemPullRequests(
        repository.id,
      )
      const unfinishedCreatePrWorkItems =
        yield* db.listUnfinishedCreatePrWorkItems(repository.id)

      const localByNativeId = new Map(
        localIssues.map((issue) => [
          persistedIssueIdentity(issue).nativeId,
          issue,
        ]),
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
            const context = relevantIssuePredicateContext({
              issueTracker,
              repositoryName,
              workItemPullRequestNumbers:
                workItemPullRequestsByIssue.get(issue.number) ?? new Set(),
              pendingSelfOwnership: pendingSelfByIssue.get(issue.number) ?? [],
              authorScope,
            })
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
          .map((issue) => [remoteIdentity(issue).nativeId, issue]),
      )
      competingObservations.sort(
        (left, right) => left.issueNumber - right.issueNumber,
      )
      const authoritativeIssues = [...remoteByNumber.values()]
      const upserts = authoritativeIssues
        .map((issue) => {
          const local = localByNativeId.get(remoteIdentity(issue).nativeId)
          if (!local) {
            return { operation: "insert" as const, issue }
          }
          if (!matches(local, issue, issueTracker)) {
            return { operation: "update" as const, issue }
          }
          return undefined
        })
        .filter((entry) => entry !== undefined)
        .sort((left, right) => left.issue.number - right.issue.number)
      const deletions = localIssues
        .filter(
          (issue) =>
            !remoteByNumber.has(persistedIssueIdentity(issue).nativeId),
        )
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
            issueTracker,
            ...remoteIdentity(issue),
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
                    ...referenceIdentity(issue.parent),
                  },
            blockedBy: issue.blockedBy.map((dependency) => ({
              issueNumber: dependency.number,
              issueUrl: dependency.url,
              ...referenceIdentity(dependency),
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
          .deleteIssueByNativeId(
            repository.id,
            issue.issueTracker ?? issueTracker,
            persistedIssueIdentity(issue).nativeId,
          )
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
