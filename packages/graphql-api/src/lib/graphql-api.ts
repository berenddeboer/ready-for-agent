import { Effect, type ManagedRuntime, Result, Semaphore, Stream } from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  ActiveAgentBackend,
  type AgentBackendStatus,
  type SessionTelemetry,
  type SessionTelemetryAvailability,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
  listBuiltInAgentBackends,
} from "@ready-for-agent/agent-backend"
import { DbService, RepositoryNotFoundError } from "@ready-for-agent/db-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import type { QueueService } from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  type WorkItemRecord,
  type WorkItemsListKind,
  filterWorkItemsByListKind,
  isJobsCompletedWorkItemState,
  isRetryableFailedWorkItem,
  isRetryableNeedsHumanWorkItem,
  isTerminalWorkItemState,
} from "@ready-for-agent/work-item-lifecycle"
import {
  commandExistsOnPath,
  resolveAddRepositoryCommand,
} from "./add-repository-command.js"
import {
  activateRepositoryPolling,
  enqueueRefreshRepositoryJob,
  suspendRepositoryPolling,
} from "./issue-polling.js"
import {
  RepositoryCredentialError,
  activatePollingIfCredentialed,
  githubTokenSecretName,
  repositoryCredential,
} from "./repository-credentials.js"
import { toGraphQLError } from "./to-graphql-error.js"
import {
  latestStepRun,
  lifecycleLabels,
  statusLabel,
  workIssueProjection,
  workItemStateLabel,
  workItemStatus,
  workItemStatusMessage,
} from "./work-item-projection.js"

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
    selectedAgentBackend: string
    defaultModel?: string | null
    defaultThinkingLevel?: string | null
    reviewModel?: string | null
    reviewThinkingLevel?: string | null
    maxConcurrentAgentTurns: number
    maxConcurrentWorkItems: number
  }
}

type UpdateRepositorySettingsArgs = {
  input: {
    repositoryId: string
    paused: boolean
    defaultModel: string | null
    defaultThinkingLevel: string | null
    reviewModel: string | null
    reviewThinkingLevel: string | null
    autoMerge: boolean
    includeAllIssueAuthors: boolean
  }
}

type IssuesArgs = {
  repositoryId: string
}

type WorkItemsArgs = IssuesArgs & {
  githubIssueNumber?: number
  listKind?: "WORKING" | "FAILED" | "COMPLETED"
  limit?: number
}

type CommittedPullRequestsCountArgs = {
  from: string
  to: string
}

type SessionArgs = {
  workItemId: string
}

const toGraphqlSessionAvailability = (
  availability: SessionTelemetryAvailability,
): "AVAILABLE" | "MISSING" | "UNAVAILABLE" | "UNSUPPORTED" => {
  if (availability === "available") return "AVAILABLE"
  if (availability === "missing") return "MISSING"
  if (availability === "unsupported") return "UNSUPPORTED"
  return "UNAVAILABLE"
}

const toGraphqlBackend = (backend: {
  readonly id: string
  readonly label: string
}) => ({
  id: backend.id,
  label: backend.label,
})

const toGraphqlSession = (session: SessionTelemetry) => ({
  id: session.id,
  availability: toGraphqlSessionAvailability(session.availability),
  backend: toGraphqlBackend(session.backend),
  model:
    session.model === null
      ? null
      : {
          providerId: session.model.providerId,
          id: session.model.id,
          thinkingLevel: session.model.thinkingLevel,
        },
  tokens: session.tokens,
  cost: session.cost,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

const toGraphqlAgentBackendStatus = (status: AgentBackendStatus) => ({
  selectedBackend: toGraphqlBackend(status.selectedBackend),
  activeBackend: toGraphqlBackend(status.activeBackend),
  kind: status.kind.toUpperCase(),
  reason: status.reason,
  models: status.models,
})

const resolveWorkItemBackend = (agentBackendId: string) => {
  const registration = getBuiltInAgentBackend(agentBackendId)
  if (registration !== undefined) {
    return registration.descriptor
  }
  return { id: agentBackendId, label: agentBackendId }
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
  if (listKind === "FAILED") return "failed"
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

export type GraphqlServices =
  | DbService
  | KeymaxxerService
  | ActiveAgentBackend
  | QueueService
  | WorkItemLifecycle

export type GraphqlRuntime = ManagedRuntime.ManagedRuntime<
  GraphqlServices,
  unknown
>

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
  options: {
    readonly agentBackendCwd?: string
    /** @deprecated Use agentBackendCwd */
    readonly opencodeCwd?: string
    readonly commandExists?: (command: string) => boolean
  } = {},
) => {
  const agentBackendCwd =
    options.agentBackendCwd ?? options.opencodeCwd ?? process.cwd()
  const commandExists = options.commandExists ?? commandExistsOnPath
  const tokenProvisioning = Effect.runSync(Semaphore.make(1))

  const runGraphql = <A>(
    effect: Effect.Effect<A, unknown, GraphqlServices>,
  ): Promise<A> =>
    runtime.runPromise(Effect.result(effect)).then((result) => {
      if (Result.isFailure(result)) {
        throw toGraphQLError(result.failure)
      }
      return result.success
    })

  const listModels = Effect.fn("graphql-api.models")(function* () {
    const active = yield* ActiveAgentBackend
    const status = yield* active.getStatus
    return status.models
  })

  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers: {
        Query: {
          health: () => true,
          addRepositoryCommand: () =>
            resolveAddRepositoryCommand(commandExists),
          repositories: async () =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.listRepositories
              }).pipe(Effect.withSpan("graphql-api.repositories")),
            ),
          repositoryCredentials: async () =>
            runGraphql(
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
              }).pipe(Effect.withSpan("graphql-api.repositoryCredentials")),
            ),
          config: async () =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.getConfig
              }).pipe(Effect.withSpan("graphql-api.config")),
            ),
          agentBackends: () =>
            listBuiltInAgentBackends().map((entry) =>
              toGraphqlBackend(entry.descriptor),
            ),
          agentBackendStatus: async () =>
            runGraphql(
              Effect.gen(function* () {
                const active = yield* ActiveAgentBackend
                return toGraphqlAgentBackendStatus(yield* active.getStatus)
              }).pipe(Effect.withSpan("graphql-api.agentBackendStatus")),
            ),
          models: async () => runGraphql(listModels()),
          issues: async (_parent: unknown, args: IssuesArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const issues = yield* db.listIssues(args.repositoryId)
                return workIssueProjection(issues)
              }).pipe(Effect.withSpan("graphql-api.issues")),
            ),
          workItems: async (_parent: unknown, args: WorkItemsArgs) =>
            runGraphql(
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
                    isJobsCompletedWorkItemState(workItem.state) ||
                    !isTerminalWorkItemState(workItem.state) ||
                    relevantIssueNumbers.has(workItem.githubIssueNumber),
                )
                return filterWorkItemsByListKind(visible, listKind, limit)
              }).pipe(Effect.withSpan("graphql-api.workItems")),
            ),
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
            return runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.countCommittedPullRequests(fromMs, toMs)
              }).pipe(
                Effect.withSpan("graphql-api.committedPullRequestsCount"),
              ),
            )
          },
          session: async (_parent: unknown, args: SessionArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                const workItem = yield* lifecycle
                  .getWorkItem(args.workItemId)
                  .pipe(
                    Effect.catchTag("WorkItemNotFoundError", () =>
                      Effect.succeed(null),
                    ),
                  )
                if (workItem === null) {
                  return null
                }
                const active = yield* ActiveAgentBackend
                const session = yield* active.getSessionTelemetry({
                  backendId: workItem.agentBackend,
                  sessionId: workItem.sessionId,
                })
                return toGraphqlSession(session)
              }).pipe(Effect.withSpan("graphql-api.session")),
            ),
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
          agentBackend: (workItem: WorkItemRecord) =>
            toGraphqlBackend(resolveWorkItemBackend(workItem.agentBackend)),
          state: (workItem: { state: string }) => workItem.state.toUpperCase(),
          stateLabel: (workItem: WorkItemRecord) =>
            workItemStateLabel(workItem),
          status: (workItem: WorkItemRecord) =>
            workItemStatus(workItem).toUpperCase(),
          statusLabel: (workItem: WorkItemRecord) =>
            statusLabel(workItemStatus(workItem)),
          statusMessage: (workItem: WorkItemRecord) =>
            workItemStatusMessage(workItem),
          paused: (workItem: WorkItemRecord) => workItem.paused,
          canRetry: (workItem: WorkItemRecord) => {
            const latestStatus = latestStepRun(workItem)?.status
            const recoverableStatusCheckFailure =
              isRetryableFailedWorkItem(workItem)
            return (
              workItem.waitingSince == null &&
              !workItem.paused &&
              (recoverableStatusCheckFailure ||
                isRetryableNeedsHumanWorkItem(workItem) ||
                (!isTerminalWorkItemState(workItem.state) &&
                  (latestStatus === "failed" ||
                    latestStatus === "interrupted")))
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
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.repositoryChanges,
                  )
                }).pipe(Effect.withSpan("graphql-api.repositoriesChanged")),
              ),
            resolve: () => true,
          },
          issuesChanged: {
            subscribe: async (_parent: unknown, args: RefreshRepositoryArgs) =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.issueChanges.pipe(
                      Stream.filter(
                        (repositoryId) => repositoryId === args.repositoryId,
                      ),
                    ),
                  )
                }).pipe(Effect.withSpan("graphql-api.issuesChanged")),
              ),
            resolve: () => true,
          },
          repositoryIssuesChanged: {
            subscribe: async () =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.issueChanges)
                }).pipe(Effect.withSpan("graphql-api.repositoryIssuesChanged")),
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
          repositoryWorkItemsChanged: {
            subscribe: async () =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.workItemChanges)
                }).pipe(
                  Effect.withSpan("graphql-api.repositoryWorkItemsChanged"),
                ),
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
        },
        Mutation: {
          updateConfig: async (_parent: unknown, args: UpdateConfigArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const previous = yield* db.getConfig
                const updated = yield* db.updateConfig({
                  selectedAgentBackend: args.input.selectedAgentBackend,
                  defaultModel: args.input.defaultModel ?? null,
                  defaultThinkingLevel: args.input.defaultThinkingLevel ?? null,
                  reviewModel: args.input.reviewModel ?? null,
                  reviewThinkingLevel: args.input.reviewThinkingLevel ?? null,
                  maxConcurrentAgentTurns: args.input.maxConcurrentAgentTurns,
                  maxConcurrentWorkItems: args.input.maxConcurrentWorkItems,
                })
                if (
                  updated.selectedAgentBackend !==
                    previous.selectedAgentBackend &&
                  isSelectableAgentBackendId(updated.selectedAgentBackend)
                ) {
                  const active = yield* ActiveAgentBackend
                  yield* active.setSelectedBackend(updated.selectedAgentBackend)
                }
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
              }).pipe(Effect.withSpan("graphql-api.updateConfig")),
            ),
          recheckAgentBackend: async () =>
            runGraphql(
              Effect.gen(function* () {
                const active = yield* ActiveAgentBackend
                const status = yield* active.recheck({
                  cwd: agentBackendCwd,
                  timeout: "30 seconds",
                })
                return toGraphqlAgentBackendStatus(status)
              }).pipe(Effect.withSpan("graphql-api.recheckAgentBackend")),
            ),
          updateRepositorySettings: async (
            _parent: unknown,
            args: UpdateRepositorySettingsArgs,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.updateRepositorySettings({
                  repositoryId: args.input.repositoryId,
                  paused: args.input.paused,
                  defaultModel: args.input.defaultModel ?? null,
                  defaultThinkingLevel: args.input.defaultThinkingLevel ?? null,
                  reviewModel: args.input.reviewModel ?? null,
                  reviewThinkingLevel: args.input.reviewThinkingLevel ?? null,
                  autoMerge: args.input.autoMerge,
                  includeAllIssueAuthors: args.input.includeAllIssueAuthors,
                })
              }).pipe(Effect.withSpan("graphql-api.updateRepositorySettings")),
            ),
          pauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.pauseRepository(args.repositoryId)
              }).pipe(Effect.withSpan("graphql-api.pauseRepository")),
            ),
          unpauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.unpauseRepository(args.repositoryId)
              }).pipe(Effect.withSpan("graphql-api.unpauseRepository")),
            ),
          addRepository: async (_parent: unknown, args: AddRepositoryArgs) =>
            runGraphql(
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
              }).pipe(Effect.withSpan("graphql-api.addRepository")),
            ),
          addRepositoryGitHubToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
          ) =>
            runGraphql(
              tokenProvisioning
                .withPermits(1)(
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
                )
                .pipe(Effect.withSpan("graphql-api.addRepositoryGitHubToken")),
            ),
          removeRepository: async (
            _parent: unknown,
            args: RemoveRepositoryArgs,
          ) =>
            runGraphql(
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
              }).pipe(Effect.withSpan("graphql-api.removeRepository")),
            ),
          resetWorkItem: async (_parent: unknown, args: ResetWorkItemArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.reset(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.resetWorkItem")),
            ),
          refreshRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) =>
            runGraphql(
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

                const jobId = yield* enqueueRefreshRepositoryJob(repository.id)
                return {
                  id: jobId,
                  repositoryId: repository.id,
                }
              }).pipe(Effect.withSpan("graphql-api.refreshRepository")),
            ),
          implementNow: async (_parent: unknown, args: ImplementNowArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.implementNow(
                  args.repositoryId,
                  args.githubIssueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.implementNow")),
            ),
          implementLocally: async (_parent: unknown, args: ImplementNowArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.implementLocally(
                  args.repositoryId,
                  args.githubIssueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.implementLocally")),
            ),
          retryWorkItem: async (_parent: unknown, args: WorkItemArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.retry(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.retryWorkItem")),
            ),
          pauseWorkItem: async (_parent: unknown, args: WorkItemArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.pause(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.pauseWorkItem")),
            ),
          startWorkItem: async (_parent: unknown, args: WorkItemArgs) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.start(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.startWorkItem")),
            ),
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
