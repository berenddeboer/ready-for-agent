import { Effect, Result } from "effect"
import {
  DbService,
  type RepositoryId,
  RepositoryNotFoundError,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import type { GitHubOperationOrigin } from "@ready-for-agent/github-service"
import { observeRepositoryCiGate } from "@ready-for-agent/graphql-api"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import {
  WorkItemLifecycle,
  syncNeedsHumanMergeHandoffs,
} from "@ready-for-agent/work-item-lifecycle"

export const refreshRepository = Effect.fn("refreshRepository")(function* ({
  repositoryId,
  githubOperationOrigin,
}: {
  readonly repositoryId: RepositoryId
  readonly githubOperationOrigin: GitHubOperationOrigin
}) {
  const db = yield* DbService
  const repositories = yield* db.listRepositories
  const repository = repositories.find(({ id }) => id === repositoryId)

  if (repository === undefined) {
    return yield* new RepositoryNotFoundError({ repositoryId })
  }

  return yield* refreshLoadedRepository({
    repository,
    githubOperationOrigin,
  })
})

export const refreshLoadedRepository = Effect.fn("refreshLoadedRepository")(
  function* ({
    repository,
    githubOperationOrigin,
  }: {
    readonly repository: RepositoryRecord
    readonly githubOperationOrigin: GitHubOperationOrigin
  }) {
    const db = yield* DbService
    const reconciler = yield* IssueReconciler
    const lifecycle = yield* WorkItemLifecycle

    const issueResult = yield* Effect.result(
      Effect.gen(function* () {
        const summary = yield* reconciler.reconcile(repository, {
          githubOperation: { origin: githubOperationOrigin },
        })
        yield* lifecycle.stopForCompetingIssueClosingPullRequests(
          repository.id,
          summary.competingObservations,
        )
        yield* syncNeedsHumanMergeHandoffs(repository.id)
        yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
          repository.id,
        )
        // Issue store is current: lift or fail Waiting for blockers Work Items.
        // Lifecycle owns Work Item mutations; reconciler only updates Issues.
        yield* lifecycle.releaseWaitingForBlockers(repository.id)
        yield* db.notifyIssuesChanged(repository.id)
        return summary
      }),
    )
    const ciResult = yield* Effect.result(
      observeRepositoryCiGate({
        repository,
        origin: githubOperationOrigin,
      }),
    )
    if (Result.isFailure(ciResult)) {
      yield* Effect.logWarning(
        "CI Gate observation failed during Repository refresh",
        {
          repositoryId: repository.id,
          error: ciResult.failure,
        },
      )
    }
    if (Result.isFailure(issueResult)) {
      return yield* Effect.fail(issueResult.failure)
    }
    if (Result.isFailure(ciResult)) {
      return yield* Effect.fail(ciResult.failure)
    }
    return issueResult.success
  },
)
