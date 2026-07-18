import {
  Data,
  Effect,
  type ManagedRuntime,
  Result,
  Semaphore,
  Stream,
} from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  DatabaseError,
  DbService,
  InvalidConfigInputError,
  InvalidRepositoryInputError,
  InvalidRepositorySettingsError,
  type IssueRecord,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "@ready-for-agent/github-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"
import {
  type IssueReconciler,
  ReconciliationMutationError,
} from "@ready-for-agent/issue-reconciler"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import { EnqueueError, type QueueService } from "@ready-for-agent/queue-service"
import {
  AbandonCleanupError,
  ActiveStepRunExistsError,
  BuildModelNotConfiguredError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  type OperationalLifecycleStep,
  ParentIssueError,
  ResetCleanupError,
  RetryNotEligibleError,
  STEP_RUN_REASON,
  type StepRunRecord,
  UnfinishedWorkItemExistsError,
  WAITING_FOR_WORKER_SLOT_MESSAGE,
  WorkItemLifecycle,
  WorkItemLifecycleDatabaseError,
  WorkItemNotFoundError,
  type WorkItemRecord,
  WorkItemTerminalError,
  type WorkItemsListKind,
  filterWorkItemsByListKind,
  isTerminalWorkItemState,
} from "@ready-for-agent/work-item-lifecycle"
import {
  activateRepositoryPolling,
  enqueueRefreshRepositoryJob,
  suspendRepositoryPolling,
} from "./issue-polling.js"

type AddRepositoryArgs = {
  input: {
    githubOwner: string
    githubRepo: string
    localPath: string
    isBare: boolean
  }
}

type RefreshRepositoryArgs = {
  repositoryId: string
}

type RemoveRepositoryArgs = {
  repositoryId: string
}

type RepositoryCredentialArgs = {
  repositoryId: string
}

type UpdateConfigArgs = {
  input: {
    defaultModel: string
    defaultVariant: string
    reviewModel?: string | null
    reviewVariant?: string | null
    maxConcurrentOpencodeSessions: number
    maxConcurrentWorkItems: number
  }
}

type UpdateRepositorySettingsArgs = {
  input: {
    repositoryId: string
    paused: boolean
    defaultModel: string | null
    defaultVariant: string | null
    reviewModel: string | null
    reviewVariant: string | null
    autoMerge: boolean
  }
}

type IssuesArgs = {
  repositoryId: string
}

type WorkItemsArgs = IssuesArgs & {
  githubIssueNumber?: number
  listKind?: "WORKING" | "COMPLETED"
  limit?: number
}

type CommittedPullRequestsCountArgs = {
  from: string
  to: string
}

const parseIsoInstantMs = (value: string, field: string): number => {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new GraphQLError(`Invalid ISO instant for ${field}: ${value}`, {
      extensions: { code: "BAD_USER_INPUT" },
    })
  }
  return ms
}

const toWorkItemsListKind = (
  listKind: WorkItemsArgs["listKind"],
): WorkItemsListKind | undefined => {
  if (listKind === "WORKING") return "working"
  if (listKind === "COMPLETED") return "completed"
  return undefined
}

type ImplementNowArgs = IssuesArgs & {
  githubIssueNumber: number
}

type WorkItemArgs = {
  workItemId: string
}

type ResetWorkItemArgs = WorkItemArgs

const childIssueCategory = (issue: IssueRecord): number => {
  if (issue.state === "CLOSED") return 2
  return issue.blockedBy.length === 0 ? 0 : 1
}

const compareChildIssues = (left: IssueRecord, right: IssueRecord): number =>
  childIssueCategory(left) - childIssueCategory(right) ||
  (left.parentPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.parentPosition ?? Number.MAX_SAFE_INTEGER) ||
  left.githubIssueNumber - right.githubIssueNumber

const workIssueProjection = (
  issues: readonly IssueRecord[],
): readonly IssueRecord[] => {
  const childrenByParent = new Map<number, IssueRecord[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.githubIssueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.githubIssueNumber, children)
  }

  return issues
    .filter((issue) => issue.parent === null)
    .sort((left, right) => right.githubIssueNumber - left.githubIssueNumber)
    .flatMap((issue) => {
      if (!issue.hasChildren) return [issue]
      const children = childrenByParent.get(issue.githubIssueNumber) ?? []
      if (children.length === 0) return []
      return [issue, ...children.sort(compareChildIssues)]
    })
}

type WorkItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "complete"
  | "abandoned"
  | "needs_human"
  | "needs_human_review"
  | "waiting_for_worker_slot"

type LifecyclePhase =
  | Exclude<
      OperationalLifecycleStep,
      "watch_pr_status_checks" | "investigate_pr_status_checks"
    >
  | "github_status_checks"

const lifecyclePhase = (step: OperationalLifecycleStep): LifecyclePhase => {
  if (
    step === "watch_pr_status_checks" ||
    step === "investigate_pr_status_checks"
  ) {
    return "github_status_checks"
  }
  return step
}

const lifecyclePhaseLabel = (phase: LifecyclePhase): string => {
  switch (phase) {
    case "implement":
      return "Build"
    case "assess_changes":
      return "Assess changes"
    case "resolve_pr_merge_conflict":
      return "Resolve PR merge conflict"
    case "github_status_checks":
      return "GitHub status checks"
    case "mark_pr_ready_for_review":
      return "Mark PR ready for review"
    case "decide_pr_merge":
      return "Decide PR merge"
    case "merge_pr":
      return "Merge PR"
    default:
      return phase
        .replaceAll("_", " ")
        .replace(/^./, (first) => first.toUpperCase())
  }
}

const statusLabel = (status: WorkItemStatus): string =>
  status.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase())

const latestStepRun = (workItem: WorkItemRecord): StepRunRecord | undefined =>
  workItem.stepRuns.at(-1)

/** Running Step Run blocked on maxConcurrentOpencodeSessions → operator Queued. */
const isWaitingForOpencodeSession = (stepRun: StepRunRecord): boolean =>
  stepRun.status === "running" &&
  stepRun.reasonCode === STEP_RUN_REASON.waitingForOpencodeSession

const stepRunDisplayStatus = (stepRun: StepRunRecord): WorkItemStatus =>
  isWaitingForOpencodeSession(stepRun) ? "queued" : stepRun.status

const workItemStatus = (workItem: WorkItemRecord): WorkItemStatus => {
  if (workItem.waitingSince != null) return "waiting_for_worker_slot"
  if (isTerminalWorkItemState(workItem.state)) return workItem.state
  if (workItem.paused) return "needs_human_review"
  const latest = latestStepRun(workItem)
  if (latest === undefined) return "queued"
  return stepRunDisplayStatus(latest)
}

const lifecycleLabels = (workItem: WorkItemRecord) => {
  const latestRuns = new Map<LifecyclePhase, StepRunRecord>()
  for (const stepRun of workItem.stepRuns) {
    latestRuns.set(lifecyclePhase(stepRun.step), stepRun)
  }
  const finalStepRun = latestStepRun(workItem)
  const finalPhase =
    workItem.state === "needs_human" && finalStepRun !== undefined
      ? lifecyclePhase(finalStepRun.step)
      : null

  return [...latestRuns].map(([phase, stepRun]) => {
    const status: WorkItemStatus =
      phase === finalPhase ? "needs_human" : stepRunDisplayStatus(stepRun)
    const outcome =
      phase === "decide_pr_merge" && status === "needs_human"
        ? "Human review before merge"
        : phase === "decide_pr_merge" && status === "succeeded"
          ? "Clanker may merge"
          : phase === "merge_pr" && status === "succeeded"
            ? "Merged"
            : statusLabel(status)
    return {
      phase: phase.toUpperCase(),
      label: `${lifecyclePhaseLabel(phase)}: ${outcome}`,
      status: status.toUpperCase(),
      durationMs: stepRun.executionDurationMs,
    }
  })
}

export type GraphqlRuntime = ManagedRuntime.ManagedRuntime<
  | DbService
  | IssueReconciler
  | KeymaxxerService
  | Opencode
  | QueueService
  | WorkItemLifecycle,
  unknown
>

type Repository = {
  id: string
  githubOwner: string
  githubRepo: string
}

/** Activate durable Issue Polling only when a GitHub token is already configured. */
const activatePollingIfCredentialed = (repository: Repository) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    if (keymaxxer.enabled === false) {
      yield* activateRepositoryPolling(repository.id)
      return
    }
    const credential = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${repository.githubOwner}/${repository.githubRepo}`,
    })
    if (credential === null) return
    yield* activateRepositoryPolling(repository.id)
  })

class RepositoryCredentialError extends Data.TaggedError(
  "RepositoryCredentialError",
)<{ readonly message: string }> {}

const githubTokenSecretName = (repository: Repository) =>
  `GITHUB_TOKEN_${repository.githubOwner}_${repository.githubRepo}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

const githubTokenCreationUrl = (repository: Repository) => {
  const url = new URL("https://github.com/settings/personal-access-tokens/new")
  url.searchParams.set("name", `${repository.githubRepo} - ready-for-agent`)
  url.searchParams.set(
    "description",
    `Ready For Agent token for ${repository.githubOwner}/${repository.githubRepo}`,
  )
  url.searchParams.set("target_name", repository.githubOwner)
  url.searchParams.set("expires_in", "90")
  url.searchParams.set("issues", "write")
  url.searchParams.set("contents", "write")
  url.searchParams.set("pull_requests", "write")
  // Actions + commit statuses help with CI visibility. Per-check CheckRun nodes
  // need Checks API access, which fine-grained PATs cannot grant — see AGENTS.md.
  url.searchParams.set("actions", "read")
  url.searchParams.set("statuses", "read")
  return url.toString()
}

const repositoryCredential = (
  repository: Repository,
  existingToken: string | null,
  configured = existingToken !== null,
) => ({
  repositoryId: repository.id,
  configured,
  githubTokenSecretName: existingToken ?? githubTokenSecretName(repository),
  githubTokenCreationUrl: githubTokenCreationUrl(repository),
})

const toGraphQLError = (error: unknown): GraphQLError => {
  if (error instanceof IssueNotFoundError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} was not found in repository ${error.repositoryId}`,
      { extensions: { code: "ISSUE_NOT_FOUND" } },
    )
  }
  if (error instanceof IssueNotOpenError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} is ${error.state}, not OPEN`,
      { extensions: { code: "ISSUE_NOT_OPEN" } },
    )
  }
  if (error instanceof ParentIssueError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} has child issues and cannot be implemented directly`,
      { extensions: { code: "ISSUE_IS_PARENT" } },
    )
  }
  if (error instanceof IssueBlockedError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} is blocked by ${error.blockerCount} issue(s)`,
      { extensions: { code: "ISSUE_BLOCKED" } },
    )
  }
  if (error instanceof UnfinishedWorkItemExistsError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} already has an unfinished Work Item`,
      {
        extensions: {
          code: "UNFINISHED_WORK_ITEM_EXISTS",
          workItemId: error.workItemId,
        },
      },
    )
  }
  if (error instanceof BuildModelNotConfiguredError) {
    return new GraphQLError(error.message, {
      extensions: { code: "BUILD_MODEL_NOT_CONFIGURED" },
    })
  }
  if (error instanceof WorkItemLifecycleDatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "WORK_ITEM_LIFECYCLE_DATABASE_ERROR" },
    })
  }
  if (error instanceof WorkItemNotFoundError) {
    return new GraphQLError(`Work Item not found: ${error.workItemId}`, {
      extensions: { code: "WORK_ITEM_NOT_FOUND" },
    })
  }
  if (error instanceof WorkItemTerminalError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} is already ${error.state}`,
      { extensions: { code: "WORK_ITEM_TERMINAL" } },
    )
  }
  if (error instanceof ActiveStepRunExistsError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} already has an active Step Run`,
      { extensions: { code: "ACTIVE_STEP_RUN_EXISTS" } },
    )
  }
  if (error instanceof RetryNotEligibleError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} cannot be retried: ${error.reason}`,
      { extensions: { code: "RETRY_NOT_ELIGIBLE" } },
    )
  }
  if (error instanceof RepositoryCredentialError) {
    return new GraphQLError(error.message, {
      extensions: { code: "REPOSITORY_CREDENTIAL_ERROR" },
    })
  }
  if (error instanceof RepositoryAlreadyExistsError) {
    return new GraphQLError(
      `Repository ${error.githubOwner}/${error.githubRepo} already exists`,
      {
        extensions: { code: "REPOSITORY_ALREADY_EXISTS" },
      },
    )
  }
  if (error instanceof InvalidConfigInputError) {
    return new GraphQLError(error.message, {
      extensions: { code: "INVALID_CONFIG_INPUT", field: error.field },
    })
  }
  if (error instanceof InvalidRepositorySettingsError) {
    return new GraphQLError(error.message, {
      extensions: {
        code: "INVALID_REPOSITORY_SETTINGS",
        field: error.field,
      },
    })
  }
  if (error instanceof LocalPathInUseError) {
    return new GraphQLError(`Local path already in use: ${error.localPath}`, {
      extensions: { code: "LOCAL_PATH_IN_USE" },
    })
  }
  if (error instanceof InvalidRepositoryInputError) {
    return new GraphQLError(error.message, {
      extensions: { code: "INVALID_REPOSITORY_INPUT", field: error.field },
    })
  }
  if (error instanceof RepositoryNotFoundError) {
    return new GraphQLError(`Repository not found: ${error.repositoryId}`, {
      extensions: { code: "REPOSITORY_NOT_FOUND" },
    })
  }
  if (error instanceof GitHubRepositoryUnavailableError) {
    return new GraphQLError(
      `GitHub repository is unavailable: ${error.owner}/${error.name}`,
      { extensions: { code: "GITHUB_REPOSITORY_UNAVAILABLE" } },
    )
  }
  if (error instanceof GitHubRequestError) {
    return new GraphQLError(error.message, {
      extensions: { code: "GITHUB_REQUEST_ERROR" },
    })
  }
  if (error instanceof ReconciliationMutationError) {
    return new GraphQLError(
      `Failed to ${error.operation} while refreshing repository`,
      {
        extensions: {
          code: "REPOSITORY_REFRESH_FAILED",
          operation: error.operation,
          ...(error.githubIssueNumber === undefined
            ? {}
            : { githubIssueNumber: error.githubIssueNumber }),
          progress: error.progress,
        },
      },
    )
  }
  if (error instanceof DatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "DATABASE_ERROR" },
    })
  }
  if (error instanceof EnqueueError) {
    return new GraphQLError(error.message, {
      extensions: { code: "ENQUEUE_ERROR" },
    })
  }
  if (error instanceof WorkItemNotFoundError) {
    return new GraphQLError(`Work Item not found: ${error.workItemId}`, {
      extensions: { code: "WORK_ITEM_NOT_FOUND" },
    })
  }
  if (error instanceof WorkItemLifecycleDatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "DATABASE_ERROR" },
    })
  }
  if (error instanceof ResetCleanupError) {
    return new GraphQLError(error.message, {
      extensions: { code: "RESET_CLEANUP_FAILED" },
    })
  }
  if (error instanceof AbandonCleanupError) {
    return new GraphQLError(error.message, {
      extensions: { code: "ABANDON_CLEANUP_FAILED" },
    })
  }
  if (error instanceof GraphQLError) {
    return error
  }
  if (error instanceof Error) {
    return new GraphQLError(error.message, {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    })
  }
  return new GraphQLError("Unexpected error", {
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  })
}

const isSameOriginRequest = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  return origin === null || origin === new URL(request.url).origin
}

const toNativeResponse = (response: unknown): Response => {
  if (response instanceof Response) return response

  const compatibleResponse = response as Response
  return new Response(compatibleResponse.body, {
    headers: compatibleResponse.headers,
    status: compatibleResponse.status,
    statusText: compatibleResponse.statusText,
  })
}

export const createGraphqlApi = (
  runtime: GraphqlRuntime,
  options: { readonly opencodeCwd?: string } = {},
) => {
  const opencodeCwd = options.opencodeCwd ?? process.cwd()
  const tokenProvisioning = Effect.runSync(Semaphore.make(1))
  let modelsCache: ReadonlyArray<string> | null = null
  let modelsInFlight: Promise<ReadonlyArray<string>> | null = null
  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers: {
        Query: {
          health: () => true,
          repositories: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.listRepositories
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          repositoryCredentials: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const repositories = yield* db.listRepositories
                  const keymaxxer = yield* KeymaxxerService
                  const ambientAuthentication = keymaxxer.enabled === false
                  const tokenNames = ambientAuthentication
                    ? repositories.map(() => null)
                    : yield* keymaxxer.findSecrets(
                        repositories.map((repository) => ({
                          provider: "github",
                          account: `${repository.githubOwner}/${repository.githubRepo}`,
                        })),
                      )
                  return repositories.map((repository, index) =>
                    repositoryCredential(
                      repository,
                      tokenNames[index] ?? null,
                      ambientAuthentication || tokenNames[index] != null,
                    ),
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          config: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.getConfig
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          models: async () => {
            if (modelsCache !== null) {
              return modelsCache
            }
            if (modelsInFlight !== null) {
              return modelsInFlight
            }
            modelsInFlight = runtime
              .runPromise(
                Effect.result(
                  Effect.gen(function* () {
                    const opencode = yield* Opencode
                    return yield* opencode.listModels({
                      cwd: opencodeCwd,
                      timeout: "30 seconds",
                    })
                  }),
                ),
              )
              .then((result) => {
                modelsInFlight = null
                if (Result.isFailure(result)) {
                  throw toGraphQLError(result.failure)
                }
                modelsCache = result.success
                return result.success
              })
              .catch((error) => {
                modelsInFlight = null
                throw error
              })
            return modelsInFlight
          },
          issues: async (_parent: unknown, args: IssuesArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const issues = yield* db.listIssues(args.repositoryId)
                  return workIssueProjection(issues)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          workItems: async (_parent: unknown, args: WorkItemsArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  const listKind = toWorkItemsListKind(args.listKind)
                  const limit = args.limit
                  if (args.githubIssueNumber !== undefined) {
                    const workItems = yield* lifecycle.listWorkItemsForIssue(
                      args.repositoryId,
                      args.githubIssueNumber,
                    )
                    return filterWorkItemsByListKind(workItems, listKind, limit)
                  }
                  const db = yield* DbService
                  const [workItems, issues] = yield* Effect.all([
                    lifecycle.listWorkItemsForRepository(args.repositoryId),
                    db.listIssues(args.repositoryId),
                  ])
                  const relevantIssueNumbers = new Set(
                    issues.map((issue) => issue.githubIssueNumber),
                  )
                  const visible = workItems.filter(
                    (workItem) =>
                      !isTerminalWorkItemState(workItem.state) ||
                      relevantIssueNumbers.has(workItem.githubIssueNumber),
                  )
                  return filterWorkItemsByListKind(visible, listKind, limit)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          committedPullRequestsCount: async (
            _parent: unknown,
            args: CommittedPullRequestsCountArgs,
          ) => {
            const fromMs = parseIsoInstantMs(args.from, "from")
            const toMs = parseIsoInstantMs(args.to, "to")
            if (toMs < fromMs) {
              throw new GraphQLError(
                "`to` must be greater than or equal to `from`",
                {
                  extensions: { code: "BAD_USER_INPUT" },
                },
              )
            }
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.countCommittedPullRequests(
                    fromMs,
                    toMs,
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
        },
        Issue: {
          githubCreatedAt: (issue: { githubCreatedAt: Date }) =>
            issue.githubCreatedAt.toISOString(),
        },
        Repository: {
          issuesReconciledAt: (repository: {
            issuesReconciledAt: Date | null
          }) => repository.issuesReconciledAt?.toISOString() ?? null,
        },
        WorkItem: {
          state: (workItem: { state: string }) => workItem.state.toUpperCase(),
          stateLabel: (workItem: WorkItemRecord) => {
            if (isTerminalWorkItemState(workItem.state)) {
              return statusLabel(workItem.state)
            }
            return lifecyclePhaseLabel(lifecyclePhase(workItem.state))
          },
          status: (workItem: WorkItemRecord) =>
            workItemStatus(workItem).toUpperCase(),
          statusLabel: (workItem: WorkItemRecord) =>
            statusLabel(workItemStatus(workItem)),
          statusMessage: (workItem: WorkItemRecord) =>
            workItem.waitingSince != null
              ? WAITING_FOR_WORKER_SLOT_MESSAGE
              : (workItem.failureMessage ??
                latestStepRun(workItem)?.reasonMessage),
          paused: (workItem: WorkItemRecord) => workItem.paused,
          canRetry: (workItem: WorkItemRecord) => {
            const latestStatus = latestStepRun(workItem)?.status
            return (
              workItem.waitingSince == null &&
              !workItem.paused &&
              !isTerminalWorkItemState(workItem.state) &&
              (latestStatus === "failed" || latestStatus === "interrupted")
            )
          },
          isTerminal: (workItem: WorkItemRecord) =>
            isTerminalWorkItemState(workItem.state),
          lifecycleLabels,
          stateReadyAt: (workItem: { stateReadyAt: Date }) =>
            workItem.stateReadyAt.toISOString(),
          createdAt: (workItem: { createdAt: Date }) =>
            workItem.createdAt.toISOString(),
          updatedAt: (workItem: { updatedAt: Date }) =>
            workItem.updatedAt.toISOString(),
        },
        Subscription: {
          repositoriesChanged: {
            subscribe: async () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.repositoryChanges,
                  )
                }),
              ),
            resolve: () => true,
          },
          issuesChanged: {
            subscribe: async (_parent: unknown, args: RefreshRepositoryArgs) =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.issueChanges.pipe(
                      Stream.filter(
                        (repositoryId) => repositoryId === args.repositoryId,
                      ),
                    ),
                  )
                }),
              ),
            resolve: () => true,
          },
          repositoryIssuesChanged: {
            subscribe: async () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.issueChanges)
                }),
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
          repositoryWorkItemsChanged: {
            subscribe: async () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.workItemChanges)
                }),
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
        },
        Mutation: {
          updateConfig: async (_parent: unknown, args: UpdateConfigArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const updated = yield* db.updateConfig({
                    defaultModel: args.input.defaultModel,
                    defaultVariant: args.input.defaultVariant,
                    reviewModel: args.input.reviewModel ?? null,
                    reviewVariant: args.input.reviewVariant ?? null,
                    maxConcurrentOpencodeSessions:
                      args.input.maxConcurrentOpencodeSessions,
                    maxConcurrentWorkItems: args.input.maxConcurrentWorkItems,
                  })
                  const lifecycle = yield* WorkItemLifecycle
                  yield* lifecycle.admitWaitingWorkItems.pipe(
                    Effect.catch((error) =>
                      Effect.logError(
                        "Failed to admit waiters after config update",
                        { error: String(error) },
                      ),
                    ),
                  )
                  return updated
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          updateRepositorySettings: async (
            _parent: unknown,
            args: UpdateRepositorySettingsArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.updateRepositorySettings({
                    repositoryId: args.input.repositoryId,
                    paused: args.input.paused,
                    defaultModel: args.input.defaultModel ?? null,
                    defaultVariant: args.input.defaultVariant ?? null,
                    reviewModel: args.input.reviewModel ?? null,
                    reviewVariant: args.input.reviewVariant ?? null,
                    autoMerge: args.input.autoMerge,
                  })
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          pauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.pauseRepository(args.repositoryId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          unpauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.unpauseRepository(args.repositoryId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          addRepository: async (_parent: unknown, args: AddRepositoryArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const added = yield* db.addRepository(args.input)
                  yield* activatePollingIfCredentialed(added).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning(
                        "Automatic Repository polling was not activated",
                        {
                          repositoryId: added.id,
                          error,
                        },
                      ),
                    ),
                  )
                  return added
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          addRepositoryGitHubToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                tokenProvisioning.withPermits(1)(
                  Effect.gen(function* () {
                    const db = yield* DbService
                    const repositories = yield* db.listRepositories
                    const repository = repositories.find(
                      ({ id }) => id === args.repositoryId,
                    )
                    if (repository === undefined) {
                      return yield* new RepositoryNotFoundError({
                        repositoryId: args.repositoryId,
                      })
                    }

                    const keymaxxer = yield* KeymaxxerService
                    const account = `${repository.githubOwner}/${repository.githubRepo}`
                    const existingToken = yield* keymaxxer.findSecret({
                      provider: "github",
                      account,
                    })
                    let tokenName = existingToken
                    if (tokenName === null) {
                      tokenName = githubTokenSecretName(repository)
                      if (yield* keymaxxer.hasSecret(tokenName)) {
                        return yield* new RepositoryCredentialError({
                          message: `Keymaxxer secret ${tokenName} already exists for another account`,
                        })
                      }
                      const added = yield* keymaxxer.addSecret({
                        name: tokenName,
                        provider: "github",
                        account,
                        environment: "prod",
                        access: "read-write",
                        description: `Fine-grained GitHub token for Ready for Agent on ${account}`,
                        tags: "ready-for-agent,harness,github",
                      })
                      if (!added) {
                        return yield* new RepositoryCredentialError({
                          message: "Keymaxxer GitHub token setup was cancelled",
                        })
                      }
                      tokenName = yield* keymaxxer.findSecret({
                        provider: "github",
                        account,
                      })
                      if (tokenName === null) {
                        return yield* new RepositoryCredentialError({
                          message:
                            "The saved Keymaxxer secret does not match this GitHub repository",
                        })
                      }
                    }
                    yield* activateRepositoryPolling(repository.id).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          "Automatic Repository polling was not activated",
                          {
                            repositoryId: repository.id,
                            error,
                          },
                        ),
                      ),
                    )
                    return repositoryCredential(repository, tokenName)
                  }),
                ),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          removeRepositoryGitHubToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                tokenProvisioning.withPermits(1)(
                  Effect.gen(function* () {
                    const db = yield* DbService
                    const repositories = yield* db.listRepositories
                    const repository = repositories.find(
                      ({ id }) => id === args.repositoryId,
                    )
                    if (repository === undefined) {
                      return yield* new RepositoryNotFoundError({
                        repositoryId: args.repositoryId,
                      })
                    }

                    const keymaxxer = yield* KeymaxxerService
                    const account = `${repository.githubOwner}/${repository.githubRepo}`
                    const existingToken = yield* keymaxxer.findSecret({
                      provider: "github",
                      account,
                    })
                    if (existingToken !== null) {
                      yield* keymaxxer.removeSecret(existingToken)
                    }
                    yield* suspendRepositoryPolling(repository.id).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          "Repository polling was not suspended",
                          {
                            repositoryId: repository.id,
                            error,
                          },
                        ),
                      ),
                    )
                    return repositoryCredential(repository, null)
                  }),
                ),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          removeRepository: async (
            _parent: unknown,
            args: RemoveRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  yield* db.removeRepository(args.repositoryId)
                  yield* suspendRepositoryPolling(args.repositoryId).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning(
                        "Repository polling was not suspended after removal",
                        {
                          repositoryId: args.repositoryId,
                          error,
                        },
                      ),
                    ),
                  )
                  return args.repositoryId
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          resetWorkItem: async (_parent: unknown, args: ResetWorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.reset(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          refreshRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const repositories = yield* db.listRepositories
                  const repository = repositories.find(
                    ({ id }) => id === args.repositoryId,
                  )
                  if (repository === undefined) {
                    return yield* new RepositoryNotFoundError({
                      repositoryId: args.repositoryId,
                    })
                  }

                  const keymaxxer = yield* KeymaxxerService
                  if (keymaxxer.enabled !== false) {
                    const credential = yield* keymaxxer.findSecret({
                      provider: "github",
                      account: `${repository.githubOwner}/${repository.githubRepo}`,
                    })
                    if (credential === null) {
                      return yield* new RepositoryCredentialError({
                        message: `GitHub credential is not configured for ${repository.githubOwner}/${repository.githubRepo}`,
                      })
                    }
                  }

                  const jobId = yield* enqueueRefreshRepositoryJob(
                    repository.id,
                  )
                  return {
                    id: jobId,
                    repositoryId: repository.id,
                  }
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          implementNow: async (_parent: unknown, args: ImplementNowArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.implementNow(
                    args.repositoryId,
                    args.githubIssueNumber,
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          implementLocally: async (
            _parent: unknown,
            args: ImplementNowArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.implementLocally(
                    args.repositoryId,
                    args.githubIssueNumber,
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          retryWorkItem: async (_parent: unknown, args: WorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.retry(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          pauseWorkItem: async (_parent: unknown, args: WorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.pause(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          startWorkItem: async (_parent: unknown, args: WorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.start(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
        },
      },
    }),
    batching: true,
    cors: false,
    fetchAPI: { Response },
    graphqlEndpoint: "/graphql",
    graphiql: true,
  })

  return {
    fetch: async (request: Request): Promise<Response> => {
      if (!isSameOriginRequest(request)) {
        return new Response("Cross-origin GraphQL requests are not allowed", {
          status: 403,
        })
      }
      return toNativeResponse(await yoga.fetch(request))
    },
  }
}

export type GraphqlApi = ReturnType<typeof createGraphqlApi>
