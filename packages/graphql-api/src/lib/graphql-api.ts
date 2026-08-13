import {
  Cause,
  Duration,
  Effect,
  Exit,
  type ManagedRuntime,
  Result,
  Semaphore,
  Stream,
} from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  type SessionTelemetry,
  type SessionTelemetryAvailability,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
  listSelectableAgentBackendInfos,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import {
  DbService,
  InvalidConfigInputError,
  InvalidRepositorySettingsError,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  GitLabService,
  gitlabVaultAccount,
} from "@ready-for-agent/gitlab-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { classifyIntakeCandidates } from "@ready-for-agent/lifecycle-model"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import type { QueueService } from "@ready-for-agent/queue-service"
import {
  COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE,
  COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE,
  WorkItemLifecycle,
  type WorkItemRecord,
  type WorkItemsListKind,
  filterWorkItemsByListKind,
  isJobsCompletedWorkItemState,
  isJobsWorkingWorkItem,
  isRetryableFailedWorkItem,
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
  buildKanbanSourceSet,
  projectKanbanLanes,
} from "./kanban-projection.js"
import {
  RepositoryCredentialError,
  activatePollingIfCredentialed,
  githubTokenSecretName,
  gitlabHasAmbientCredentialsBounded,
  gitlabTokenSecretName,
  repositoryCredential,
  withKeymaxxerMetadataTimeout,
} from "./repository-credentials.js"
import { startRepositoryIntake } from "./repository-intake.js"
import { preflightRepositoryIntake } from "./repository-intake-preflight.js"
import { toGraphQLError } from "./to-graphql-error.js"
import { validateAgentModelsAgainstCatalog } from "./validate-agent-models.js"
import {
  lifecycleLabels,
  statusLabel,
  workIssueProjection,
  workItemCanRetry,
  workItemIsTerminal,
  workItemPostponedUntil,
  workItemStateLabel,
  workItemStatus,
  workItemStatusMessage,
} from "./work-item-projection.js"

type AddRepositoryArgs = {
  input: {
    forge: "github" | "gitlab"
    forgeHost: string
    projectPath: string
    localPath: string
    isBare: boolean
  }
}

type AddLocalRepositoryArgs = {
  path: string
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
    forge?: "github" | "gitlab"
    forgeHost?: string
    projectPath?: string
    paused: boolean
    /**
     * Undefined when the client omits the field (leave override unchanged).
     * Null clears the override (inherit harness default).
     */
    selectedAgentBackend?: string | null
    defaultModel: string | null
    defaultThinkingLevel: string | null
    reviewModel: string | null
    reviewThinkingLevel: string | null
    autoMerge: boolean
    includeAllIssueAuthors: boolean
    waitForReadyForReviewChecks: boolean
  }
}

type IssuesArgs = {
  repositoryId: string
}

type WorkItemsArgs = IssuesArgs & {
  issueNumber?: number
  listKind?: "WORKING" | "FAILED" | "COMPLETED"
  limit?: number
}

type CompletedWorkItemsArgs = {
  page?: number | null
  pageSize?: number | null
}

type CommittedPullRequestsCountArgs = {
  from: string
  to: string
}

/** Normalize 1-based page / pageSize for historical Completed pagination. */
const normalizeCompletedWorkItemsPage = (
  page: number | null | undefined,
  pageSize: number | null | undefined,
): { page: number; pageSize: number } => {
  const normalizedPage =
    page === null || page === undefined || !Number.isFinite(page)
      ? 1
      : Math.max(1, Math.trunc(page))
  const normalizedPageSize =
    pageSize === null ||
    pageSize === undefined ||
    !Number.isFinite(pageSize) ||
    pageSize < 1
      ? COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE
      : Math.min(COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE, Math.trunc(pageSize))
  return { page: normalizedPage, pageSize: normalizedPageSize }
}

type SessionArgs = {
  workItemId: string
}

type WorkItemBySessionIdArgs = {
  sessionId: string
}

type KanbanStatusArgs = {
  repositoryId?: string | null
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

const toGraphqlProvider = (
  provider: AgentBackendStatus["provider"] | null | undefined,
) =>
  provider === null || provider === undefined
    ? null
    : { id: provider.id, label: provider.label }

const toGraphqlAgentBackendStatus = (
  status: AgentBackendStatus | AgentBackendRuntimeStatus,
) => {
  const singular: AgentBackendStatus =
    "selectedBackend" in status ? status : toAgentBackendStatus(status)
  return {
    backend: toGraphqlBackend(singular.selectedBackend),
    selectedBackend: toGraphqlBackend(singular.selectedBackend),
    activeBackend: toGraphqlBackend(singular.activeBackend),
    kind: singular.kind.toUpperCase(),
    reason: singular.reason,
    models: singular.models,
    provider: toGraphqlProvider(singular.provider),
    warnings: [...singular.warnings],
  }
}

const effectiveAgentBackendId = (
  repositoryOverride: string | null,
  harnessDefault: string,
): string => repositoryOverride ?? harnessDefault

const inspectInput = (cwd: string) =>
  ({
    cwd,
    timeout: "30 seconds" as const,
  }) satisfies { cwd: string; timeout: "30 seconds" }

const toGraphqlAgentBackendPreview = (preview: {
  readonly backend: AgentBackendStatus["selectedBackend"]
  readonly kind: "ready" | "unavailable"
  readonly reason: string | null
  readonly models: AgentBackendStatus["models"]
  readonly provider: AgentBackendStatus["provider"]
  readonly warnings: ReadonlyArray<string>
}) => ({
  backend: toGraphqlBackend(preview.backend),
  kind: preview.kind.toUpperCase(),
  reason: preview.reason,
  models: preview.models,
  provider: toGraphqlProvider(preview.provider),
  warnings: [...preview.warnings],
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
  issueNumber: number
}

type WorkItemArgs = {
  workItemId: string
}

type ResetWorkItemArgs = WorkItemArgs

export type GraphqlServices =
  | DbService
  | GitHubService
  | GitLabService
  | KeymaxxerService
  | ActiveAgentBackend
  | QueueService
  | WorkItemLifecycle
  | LocalGit
  | DirectoryPicker

export type GraphqlRuntime = ManagedRuntime.ManagedRuntime<
  GraphqlServices,
  unknown
>

/** Yoga provides the HTTP Request on context; its signal drives Effect interruption. */
export type GraphqlRequestContext = {
  readonly request: Request
}

const isSameOriginRequest = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  return origin === null || origin === new URL(request.url).origin
}

const verifyRepositoryIdentity = Effect.fn(
  "graphql-api.verifyRepositoryIdentity",
)(function* (identity: {
  readonly forge: "github" | "gitlab"
  readonly forgeHost: string
  readonly projectPath: string
}) {
  if (identity.forge !== "gitlab") return identity
  const gitlab = yield* GitLabService
  const resolved = yield* gitlab.verifyProject(identity)
  return {
    forge: identity.forge,
    forgeHost: resolved.forgeHost,
    projectPath: resolved.projectPath,
  }
})

const toNativeResponse = (response: unknown): Response => {
  if (response instanceof Response) return response

  const compatibleResponse = response as Response
  return new Response(compatibleResponse.body, {
    headers: compatibleResponse.headers,
    status: compatibleResponse.status,
    statusText: compatibleResponse.statusText,
  })
}

/**
 * Bound for GraphQL-facing Keymaxxer metadata (list / find secret).
 * Long enough for an operator unlock dialog; short enough that an abandoned
 * wait does not freeze the Harness UI forever.
 */
export const DEFAULT_KEYMAXXER_METADATA_TIMEOUT = Duration.seconds(60)

export const createGraphqlApi = <R>(
  runtime: ManagedRuntime.ManagedRuntime<GraphqlServices | R, unknown>,
  options: {
    readonly agentBackendCwd?: string
    /** @deprecated Use agentBackendCwd */
    readonly opencodeCwd?: string
    readonly commandExists?: (command: string) => boolean
    /**
     * Bound for GraphQL Keymaxxer metadata waits (repositoryCredentials, etc.).
     * Defaults to {@link DEFAULT_KEYMAXXER_METADATA_TIMEOUT}.
     */
    readonly keymaxxerMetadataTimeout?: Duration.Duration
    /**
     * Process environment for Claude Code Bedrock configuration mode (issue
     * #828). Defaults to `process.env`. Tests inject a map so mode metadata
     * does not depend on the host shell.
     */
    readonly environment?: Readonly<Record<string, string | undefined>>
  } = {},
) => {
  const agentBackendCwd =
    options.agentBackendCwd ?? options.opencodeCwd ?? process.cwd()
  const commandExists = options.commandExists ?? commandExistsOnPath
  const keymaxxerMetadataTimeout =
    options.keymaxxerMetadataTimeout ?? DEFAULT_KEYMAXXER_METADATA_TIMEOUT
  const environment =
    options.environment ?? (process.env as Record<string, string | undefined>)
  const tokenProvisioning = Effect.runSync(Semaphore.make(1))

  /**
   * Run a resolver Effect with the HTTP request's AbortSignal so client
   * disconnect or fetch abort interrupts the fiber (and its finalizers).
   * Typed failures stay domain GraphQL errors; interruption is an
   * operation-level `REQUEST_CANCELLED` failure, not result data.
   */
  const runGraphql = <A>(
    effect: Effect.Effect<A, unknown, GraphqlServices>,
    context: GraphqlRequestContext,
  ): Promise<A> =>
    runtime
      .runPromiseExit(Effect.result(effect), {
        signal: context.request.signal,
      })
      .then((exit) => {
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) {
            throw new GraphQLError("Request cancelled", {
              extensions: { code: "REQUEST_CANCELLED" },
            })
          }
          throw toGraphQLError(Cause.squash(exit.cause))
        }
        const result = exit.value
        if (Result.isFailure(result)) {
          throw toGraphQLError(result.failure)
        }
        return result.success
      })

  const listModels = Effect.fn("graphql-api.models")(function* () {
    const active = yield* ActiveAgentBackend
    const db = yield* DbService
    const config = yield* db.getConfig
    if (isSelectableAgentBackendId(config.selectedAgentBackend)) {
      const status = yield* active.getBackendStatus(
        config.selectedAgentBackend as AgentBackendId,
      )
      if (status !== null) {
        return status.models
      }
    }
    // Fall back to proxy status when default is not yet Active.
    return (yield* active.getStatus).models
  })

  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers: {
        Query: {
          health: () => true,
          addRepositoryCommand: () =>
            resolveAddRepositoryCommand(commandExists),
          directoryPickerAvailable: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const picker = yield* DirectoryPicker
                return yield* picker.available
              }).pipe(Effect.withSpan("graphql-api.directoryPickerAvailable")),
              context,
            ),
          repositories: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.listRepositories
              }).pipe(Effect.withSpan("graphql-api.repositories")),
              context,
            ),
          repositoryCredentials: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const repositories = yield* db.listRepositories
                const keymaxxer = yield* KeymaxxerService
                const ambientAuthentication = keymaxxer.enabled === false
                const githubRepositories = repositories.filter(
                  ({ forge }) => forge === "github",
                )
                const gitlabRepositories = repositories.filter(
                  ({ forge }) => forge === "gitlab",
                )
                const githubTokenNames = ambientAuthentication
                  ? githubRepositories.map(() => null)
                  : githubRepositories.length === 0
                    ? []
                    : yield* withKeymaxxerMetadataTimeout(
                        keymaxxer.findSecrets(
                          githubRepositories.map((repository) => ({
                            provider: "github",
                            account: repository.projectPath,
                          })),
                        ),
                        keymaxxerMetadataTimeout,
                        "findSecrets",
                      )
                // GitLab vault batch: on timeout/error, treat every repo as a
                // vault miss and fall through to ambient hasCredentials so
                // ambient-only GitLab stays usable when the vault is locked.
                const gitlabTokenNames = ambientAuthentication
                  ? gitlabRepositories.map(() => null)
                  : gitlabRepositories.length === 0
                    ? []
                    : yield* withKeymaxxerMetadataTimeout(
                        keymaxxer.findSecrets(
                          gitlabRepositories.map((repository) => ({
                            provider: "gitlab",
                            account: gitlabVaultAccount(repository),
                          })),
                        ),
                        keymaxxerMetadataTimeout,
                        "findSecrets",
                      ).pipe(
                        Effect.catchTag("KeymaxxerError", () =>
                          Effect.succeed(
                            gitlabRepositories.map(() => null as string | null),
                          ),
                        ),
                      )
                let githubIndex = 0
                let gitlabIndex = 0
                return yield* Effect.forEach(
                  repositories,
                  (repository) => {
                    if (repository.forge === "gitlab") {
                      const vaultTokenName =
                        gitlabTokenNames[gitlabIndex++] ?? null
                      if (vaultTokenName !== null) {
                        return Effect.succeed(
                          repositoryCredential(
                            repository,
                            vaultTokenName,
                            true,
                          ),
                        )
                      }
                      // Ambient-only: vault already probed (batch miss or
                      // timeout) — do not re-enter findSecret or re-apply the
                      // full metadata timeout (avoids stacking waits).
                      return gitlabHasAmbientCredentialsBounded(
                        repository,
                      ).pipe(
                        Effect.map((configured) =>
                          repositoryCredential(repository, null, configured),
                        ),
                      )
                    }
                    const tokenName = githubTokenNames[githubIndex++] ?? null
                    return Effect.succeed(
                      repositoryCredential(
                        repository,
                        tokenName,
                        ambientAuthentication || tokenName !== null,
                      ),
                    )
                  },
                  { concurrency: "unbounded" },
                )
              }).pipe(Effect.withSpan("graphql-api.repositoryCredentials")),
              context,
            ),
          config: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const [
                  config,
                  unfinishedWorkItemCount,
                  blockingUnfinishedWorkItemCount,
                ] = yield* Effect.all([
                  db.getConfig,
                  db.countUnfinishedWorkItems,
                  db.countBlockingUnfinishedForGlobalDefault,
                ])
                return {
                  ...config,
                  unfinishedWorkItemCount,
                  blockingUnfinishedWorkItemCount,
                }
              }).pipe(Effect.withSpan("graphql-api.config")),
              context,
            ),
          agentBackends: () =>
            listSelectableAgentBackendInfos(environment).map((entry) => ({
              id: entry.id,
              label: entry.label,
              configurationMode: entry.configurationMode,
            })),
          agentBackendStatuses: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const active = yield* ActiveAgentBackend
                const statuses = yield* active.listStatuses
                return statuses.map((status) =>
                  toGraphqlAgentBackendStatus(status),
                )
              }).pipe(Effect.withSpan("graphql-api.agentBackendStatuses")),
              context,
            ),
          agentBackendStatus: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const active = yield* ActiveAgentBackend
                const db = yield* DbService
                const config = yield* db.getConfig
                if (isSelectableAgentBackendId(config.selectedAgentBackend)) {
                  const runtime = yield* active.getBackendStatus(
                    config.selectedAgentBackend as AgentBackendId,
                  )
                  if (runtime !== null) {
                    return toGraphqlAgentBackendStatus(runtime)
                  }
                }
                return toGraphqlAgentBackendStatus(yield* active.getStatus)
              }).pipe(Effect.withSpan("graphql-api.agentBackendStatus")),
              context,
            ),
          previewAgentBackend: async (
            _parent: unknown,
            args: { backendId: string },
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const backendId = args.backendId.trim()
                if (!isSelectableAgentBackendId(backendId)) {
                  return {
                    backend: {
                      id: args.backendId,
                      label: args.backendId,
                    },
                    kind: "UNAVAILABLE",
                    reason: `Unknown Agent Backend: ${args.backendId}`,
                    models: [],
                    provider: null,
                    warnings: [] as const,
                  }
                }
                const active = yield* ActiveAgentBackend
                const preview = yield* active.preview(backendId, {
                  cwd: agentBackendCwd,
                  timeout: "30 seconds",
                })
                return toGraphqlAgentBackendPreview(preview)
              }).pipe(Effect.withSpan("graphql-api.previewAgentBackend")),
              context,
            ),
          harnessModelPrefs: async (
            _parent: unknown,
            args: { backendId: string },
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.getBackendModelPrefs(args.backendId)
              }).pipe(Effect.withSpan("graphql-api.harnessModelPrefs")),
              context,
            ),
          models: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) => runGraphql(listModels(), context),
          issues: async (
            _parent: unknown,
            args: IssuesArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const issues = yield* db.listIssues(args.repositoryId)
                return workIssueProjection(issues)
              }).pipe(Effect.withSpan("graphql-api.issues")),
              context,
            ),
          intakeCandidates: async (
            _parent: unknown,
            args: IssuesArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const lifecycle = yield* WorkItemLifecycle
                const repositories = yield* db.listRepositories
                const repository = repositories.find(
                  ({ id }) => id === args.repositoryId,
                )
                if (repository === undefined) {
                  return yield* new RepositoryNotFoundError({
                    repositoryId: args.repositoryId,
                  })
                }

                // Current Issue projection only — never request or wait for Refresh.
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

                // Empty classification is a successful no-op and skips preflight.
                if (candidates.length > 0) {
                  // Preflight re-reads Repository under Config coordination.
                  yield* preflightRepositoryIntake(repository.id)
                }

                return {
                  repository,
                  candidates,
                }
              }).pipe(Effect.withSpan("graphql-api.intakeCandidates")),
              context,
            ),
          workItems: async (
            _parent: unknown,
            args: WorkItemsArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                const listKind = toWorkItemsListKind(args.listKind)
                const limit = args.limit
                const nowMs = Date.now()
                if (args.issueNumber !== undefined) {
                  const workItems = yield* lifecycle.listWorkItemsForIssue(
                    args.repositoryId,
                    args.issueNumber,
                  )
                  return filterWorkItemsByListKind(
                    workItems,
                    listKind,
                    limit,
                    nowMs,
                  )
                }
                const db = yield* DbService
                const [workItems, issues] = yield* Effect.all([
                  lifecycle.listWorkItemsForRepository(args.repositoryId),
                  db.listIssues(args.repositoryId),
                ])
                const relevantIssueNumbers = new Set(
                  issues.map((issue) => issue.issueNumber),
                )
                const visible = workItems.filter(
                  (workItem) =>
                    isJobsCompletedWorkItemState(workItem.state) ||
                    isJobsWorkingWorkItem(workItem) ||
                    relevantIssueNumbers.has(workItem.issueNumber),
                )
                return filterWorkItemsByListKind(
                  visible,
                  listKind,
                  limit,
                  nowMs,
                )
              }).pipe(Effect.withSpan("graphql-api.workItems")),
              context,
            ),
          completedWorkItems: async (
            _parent: unknown,
            args: CompletedWorkItemsArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const { page, pageSize } = normalizeCompletedWorkItemsPage(
                  args.page,
                  args.pageSize,
                )
                const lifecycle = yield* WorkItemLifecycle
                const result = yield* lifecycle.listCompletedWorkItems({
                  page,
                  pageSize,
                })
                const hasPreviousPage = result.page > 1
                const hasNextPage =
                  result.page * result.pageSize < result.totalCount
                return {
                  items: result.items,
                  page: result.page,
                  pageSize: result.pageSize,
                  totalCount: result.totalCount,
                  hasNextPage,
                  hasPreviousPage,
                }
              }).pipe(Effect.withSpan("graphql-api.completedWorkItems")),
              context,
            ),
          committedPullRequestsCount: async (
            _parent: unknown,
            args: CommittedPullRequestsCountArgs,
            context: GraphqlRequestContext,
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
              context,
            )
          },
          session: async (
            _parent: unknown,
            args: SessionArgs,
            context: GraphqlRequestContext,
          ) =>
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
              context,
            ),
          workItemBySessionId: async (
            _parent: unknown,
            args: WorkItemBySessionIdArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                const found = yield* lifecycle.findWorkItemBySessionId(
                  args.sessionId,
                )
                return {
                  agentBackend: toGraphqlBackend(
                    resolveWorkItemBackend(found.agentBackend),
                  ),
                  sessionId: found.sessionId,
                  worktreePath: found.worktreePath,
                }
              }).pipe(Effect.withSpan("graphql-api.workItemBySessionId")),
              context,
            ),
          kanbanStatus: async (
            _parent: unknown,
            args: KanbanStatusArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const lifecycle = yield* WorkItemLifecycle
                const repositories = yield* db.listRepositories
                const filterRepositoryId = args.repositoryId ?? null
                const filteredRepository =
                  filterRepositoryId === null
                    ? null
                    : (repositories.find(
                        (repository) => repository.id === filterRepositoryId,
                      ) ?? null)
                if (
                  filterRepositoryId !== null &&
                  filteredRepository === null
                ) {
                  return yield* new RepositoryNotFoundError({
                    repositoryId: filterRepositoryId,
                  })
                }

                // Shared global source set first; optional Repository filter
                // applies after failed/completed windows are built.
                const perRepository = yield* Effect.forEach(
                  repositories,
                  (repository) =>
                    Effect.gen(function* () {
                      const [workItems, issues] = yield* Effect.all([
                        lifecycle.listWorkItemsForRepository(repository.id),
                        db.listIssues(repository.id),
                      ])
                      const relevantIssueNumbers = new Set(
                        issues.map((issue) => issue.issueNumber),
                      )
                      return workItems.filter(
                        (workItem) =>
                          isJobsCompletedWorkItemState(workItem.state) ||
                          isJobsWorkingWorkItem(workItem) ||
                          relevantIssueNumbers.has(workItem.issueNumber),
                      )
                    }),
                  { concurrency: "unbounded" },
                )
                const nowMs = Date.now()
                const source = buildKanbanSourceSet(perRepository.flat(), nowMs)
                const visible =
                  filterRepositoryId === null
                    ? source
                    : source.filter(
                        (workItem) =>
                          workItem.repositoryId === filterRepositoryId,
                      )
                const repositoryById = new Map<
                  string,
                  (typeof repositories)[number]
                >(repositories.map((repository) => [repository.id, repository]))
                const classifiable = visible.flatMap((workItem) => {
                  const repository = repositoryById.get(workItem.repositoryId)
                  if (repository === undefined) {
                    return []
                  }
                  return [
                    {
                      id: workItem.id,
                      repositoryId: workItem.repositoryId,
                      state: workItem.state,
                      status: workItemStatus(workItem),
                      failureCode: workItem.failureCode,
                      createdAt: workItem.createdAt,
                      stateReadyAt: workItem.stateReadyAt,
                      repository,
                      workItem,
                    },
                  ]
                })
                const lanes = projectKanbanLanes(classifiable).map((lane) => ({
                  id: lane.id,
                  label: lane.label,
                  count: lane.count,
                  workItems: lane.workItems.map((entry) => ({
                    repository: entry.repository,
                    workItem: entry.workItem,
                  })),
                }))
                return {
                  repository: filteredRepository,
                  lanes,
                }
              }).pipe(Effect.withSpan("graphql-api.kanbanStatus")),
              context,
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
          effectiveAgentBackend: async (
            repository: {
              selectedAgentBackend: string | null
            },
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const config = yield* db.getConfig
                return effectiveAgentBackendId(
                  repository.selectedAgentBackend,
                  config.selectedAgentBackend,
                )
              }).pipe(
                Effect.withSpan("graphql-api.Repository.effectiveAgentBackend"),
              ),
              context,
            ),
          blockingUnfinishedWorkItemCount: async (
            repository: { id: string },
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.countBlockingUnfinishedForRepository(
                  repository.id,
                )
              }).pipe(
                Effect.withSpan(
                  "graphql-api.Repository.blockingUnfinishedWorkItemCount",
                ),
              ),
              context,
            ),
          pullRequestCount: async (
            repository: {
              forge: string
              forgeHost: string
              projectPath: string
            },
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const forgeRepository = {
                  forge: repository.forge,
                  forgeHost: repository.forgeHost,
                  projectPath: repository.projectPath,
                }
                // Forge is authoritative: open non-draft PRs/MRs regardless of
                // Work Item ownership. GitHub observation failures must reach
                // the dedicated query cache: converting one to zero would
                // overwrite a last-known count with false data.
                if (repository.forge === "gitlab") {
                  const gitlab = yield* GitLabService
                  return yield* gitlab
                    .countOpenNonDraftPullRequests(forgeRepository)
                    .pipe(
                      Effect.catchTags({
                        GitLabProjectUnavailableError: () => Effect.succeed(0),
                        GitLabRequestError: () => Effect.succeed(0),
                      }),
                    )
                }
                if (repository.forge !== "github") return 0
                const github = yield* GitHubService
                return yield* github.countOpenNonDraftPullRequests(
                  forgeRepository,
                )
              }).pipe(
                Effect.withSpan("graphql-api.Repository.pullRequestCount"),
              ),
              context,
            ),
        },
        WorkItem: {
          agentBackend: (workItem: WorkItemRecord) =>
            toGraphqlBackend(resolveWorkItemBackend(workItem.agentBackend)),
          mergeMode: (workItem: { mergeMode: string }) =>
            workItem.mergeMode.toUpperCase(),
          state: (workItem: { state: string }) => workItem.state.toUpperCase(),
          stateLabel: (workItem: WorkItemRecord) =>
            workItemStateLabel(workItem),
          status: (workItem: WorkItemRecord) =>
            workItemStatus(workItem).toUpperCase(),
          statusLabel: (workItem: WorkItemRecord) =>
            statusLabel(workItemStatus(workItem)),
          statusMessage: async (
            workItem: WorkItemRecord,
            _args: unknown,
            context: GraphqlRequestContext,
          ) => {
            if (workItemIsTerminal(workItem) || !workItem.waitingForBlockers) {
              return workItemStatusMessage(workItem)
            }
            return runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const issues = yield* db.listIssues(workItem.repositoryId)
                const issue = issues.find(
                  (candidate) => candidate.issueNumber === workItem.issueNumber,
                )
                return workItemStatusMessage(workItem, {
                  blockerIssueNumbers:
                    issue?.blockedBy.map((blocker) => blocker.issueNumber) ??
                    [],
                })
              }).pipe(Effect.withSpan("graphql-api.WorkItem.statusMessage")),
              context,
            )
          },
          postponedUntil: (workItem: WorkItemRecord) =>
            workItemPostponedUntil(workItem)?.toISOString() ?? null,
          paused: (workItem: WorkItemRecord) => workItem.paused,
          canRetry: workItemCanRetry,
          isTerminal: workItemIsTerminal,
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
            subscribe: async (
              _parent: unknown,
              _args: unknown,
              context: GraphqlRequestContext,
            ) =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.repositoryChanges,
                  )
                }).pipe(Effect.withSpan("graphql-api.repositoriesChanged")),
                context,
              ),
            resolve: () => true,
          },
          issuesChanged: {
            subscribe: async (
              _parent: unknown,
              args: RefreshRepositoryArgs,
              context: GraphqlRequestContext,
            ) =>
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
                context,
              ),
            resolve: () => true,
          },
          repositoryIssuesChanged: {
            subscribe: async (
              _parent: unknown,
              _args: unknown,
              context: GraphqlRequestContext,
            ) =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.issueChanges)
                }).pipe(Effect.withSpan("graphql-api.repositoryIssuesChanged")),
                context,
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
          repositoryWorkItemsChanged: {
            subscribe: async (
              _parent: unknown,
              _args: unknown,
              context: GraphqlRequestContext,
            ) =>
              runGraphql(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.workItemChanges)
                }).pipe(
                  Effect.withSpan("graphql-api.repositoryWorkItemsChanged"),
                ),
                context,
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
        },
        Mutation: {
          updateConfig: async (
            _parent: unknown,
            args: UpdateConfigArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const active = yield* ActiveAgentBackend
                // Serialize config commit + activate with Work Item creation so
                // Implement Now cannot capture pre-activate Active provenance.
                const updated = yield* active.withConfigCoordination(
                  Effect.gen(function* () {
                    // Catalog-only Agent Models (issue #838): validate against
                    // the backend this Save is about to select, inside the same
                    // coordinated section that commits and activates it.
                    yield* validateAgentModelsAgainstCatalog({
                      backendId: args.input.selectedAgentBackend,
                      inspectInput: inspectInput(agentBackendCwd),
                      models: {
                        defaultModel: args.input.defaultModel,
                        reviewModel: args.input.reviewModel,
                      },
                      onInvalid: (field, message) =>
                        new InvalidConfigInputError({ field, message }),
                    })
                    const next = yield* db.updateConfig({
                      selectedAgentBackend: args.input.selectedAgentBackend,
                      defaultModel: args.input.defaultModel ?? null,
                      defaultThinkingLevel:
                        args.input.defaultThinkingLevel ?? null,
                      reviewModel: args.input.reviewModel ?? null,
                      reviewThinkingLevel:
                        args.input.reviewThinkingLevel ?? null,
                      maxConcurrentAgentTurns:
                        args.input.maxConcurrentAgentTurns,
                      maxConcurrentWorkItems: args.input.maxConcurrentWorkItems,
                    })
                    // Sync Active set to selected-or-in-use after Save (activate
                    // missing, drop unused). Same-backend members skip re-inspect.
                    const selectedOrInUse =
                      yield* db.listSelectedOrInUseBackendIds
                    const backendIds = selectedOrInUse.filter(
                      (id): id is AgentBackendId =>
                        isSelectableAgentBackendId(id),
                    )
                    yield* active.setSelectedOrInUse(
                      backendIds,
                      inspectInput(agentBackendCwd),
                    )
                    // Process-wide proxy tracks Config selected backend so
                    // legacy singular status and proxy turns stay aligned.
                    if (isSelectableAgentBackendId(next.selectedAgentBackend)) {
                      const backendId =
                        next.selectedAgentBackend as AgentBackendId
                      const proxyStatus = yield* active.getStatus
                      if (proxyStatus.activeBackend.id !== backendId) {
                        yield* active.activate(
                          backendId,
                          inspectInput(agentBackendCwd),
                        )
                      }
                    }
                    return next
                  }),
                )
                const [
                  unfinishedWorkItemCount,
                  blockingUnfinishedWorkItemCount,
                ] = yield* Effect.all([
                  db.countUnfinishedWorkItems,
                  db.countBlockingUnfinishedForGlobalDefault,
                ])
                const lifecycle = yield* WorkItemLifecycle
                yield* lifecycle.admitWaitingWorkItems.pipe(
                  Effect.catch((error) =>
                    Effect.logError(
                      "Failed to admit waiters after config update",
                      { error: String(error) },
                    ),
                  ),
                )
                return {
                  ...updated,
                  unfinishedWorkItemCount,
                  blockingUnfinishedWorkItemCount,
                }
              }).pipe(Effect.withSpan("graphql-api.updateConfig")),
              context,
            ),
          recheckAgentBackend: async (
            _parent: unknown,
            args: { backendId?: string | null },
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const active = yield* ActiveAgentBackend
                // Null/undefined omits the arg → recheck harness default.
                // Explicit empty/whitespace is an invalid id, not omit.
                const rawArg = args.backendId
                const backendId =
                  rawArg === undefined || rawArg === null
                    ? (yield* db.getConfig).selectedAgentBackend
                    : rawArg.trim()
                if (
                  backendId.length === 0 ||
                  !isSelectableAgentBackendId(backendId)
                ) {
                  // Return GraphQL shape directly — do not construct a branded
                  // AgentBackendDescriptor for unknown ids.
                  const displayId =
                    backendId.length > 0 ? backendId : (rawArg ?? "")
                  return {
                    backend: { id: displayId, label: displayId },
                    selectedBackend: { id: displayId, label: displayId },
                    activeBackend: { id: displayId, label: displayId },
                    kind: "UNAVAILABLE",
                    reason: `Unknown Agent Backend: ${displayId}`,
                    models: [] as const,
                    provider: null,
                    warnings: [] as const,
                  }
                }
                const status = yield* active.recheck(
                  backendId,
                  inspectInput(agentBackendCwd),
                )
                return toGraphqlAgentBackendStatus(status)
              }).pipe(Effect.withSpan("graphql-api.recheckAgentBackend")),
              context,
            ),
          updateRepositorySettings: async (
            _parent: unknown,
            args: UpdateRepositorySettingsArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                const active = yield* ActiveAgentBackend
                const repositories = yield* db.listRepositories
                const repository = repositories.find(
                  ({ id }) => id === args.input.repositoryId,
                )
                if (repository === undefined) {
                  return yield* new RepositoryNotFoundError({
                    repositoryId: args.input.repositoryId,
                  })
                }
                const nextIdentity = {
                  forge: args.input.forge ?? repository.forge,
                  forgeHost: args.input.forgeHost ?? repository.forgeHost,
                  projectPath: args.input.projectPath ?? repository.projectPath,
                }
                const identityChanging =
                  nextIdentity.forge !== repository.forge ||
                  nextIdentity.forgeHost !== repository.forgeHost ||
                  nextIdentity.projectPath.toLowerCase() !==
                    repository.projectPath.toLowerCase()
                // Verify (and resolve canonical API host) before persisting
                // identity changes so SSH remote hosts do not become Forge Host.
                const resolvedIdentity = identityChanging
                  ? yield* verifyRepositoryIdentity(nextIdentity)
                  : nextIdentity
                // Coordinate with Work Item creation when the effective backend
                // may change so Implement Now cannot capture a pre-activate id.
                const updated = yield* active.withConfigCoordination(
                  Effect.gen(function* () {
                    // Catalog-only Agent Models (issue #838): validate explicit
                    // overrides against the next Effective Agent Backend —
                    // the repository override when set, else the harness
                    // default. Empty overrides inherit and assert nothing.
                    const nextSelected =
                      args.input.selectedAgentBackend === undefined
                        ? repository.selectedAgentBackend
                        : args.input.selectedAgentBackend
                    const nextEffective =
                      nextSelected ?? (yield* db.getConfig).selectedAgentBackend
                    yield* validateAgentModelsAgainstCatalog({
                      backendId: nextEffective,
                      inspectInput: inspectInput(agentBackendCwd),
                      models: {
                        defaultModel: args.input.defaultModel,
                        reviewModel: args.input.reviewModel,
                      },
                      onInvalid: (field, message) =>
                        new InvalidRepositorySettingsError({ field, message }),
                    })
                    const updated = yield* db.updateRepositorySettings({
                      repositoryId: args.input.repositoryId,
                      ...(args.input.forge === undefined && !identityChanging
                        ? {}
                        : { forge: resolvedIdentity.forge }),
                      ...(args.input.forgeHost === undefined &&
                      !identityChanging
                        ? {}
                        : { forgeHost: resolvedIdentity.forgeHost }),
                      ...(args.input.projectPath === undefined &&
                      !identityChanging
                        ? {}
                        : { projectPath: resolvedIdentity.projectPath }),
                      paused: args.input.paused,
                      ...(args.input.selectedAgentBackend !== undefined
                        ? {
                            selectedAgentBackend:
                              args.input.selectedAgentBackend,
                          }
                        : {}),
                      defaultModel: args.input.defaultModel ?? null,
                      defaultThinkingLevel:
                        args.input.defaultThinkingLevel ?? null,
                      reviewModel: args.input.reviewModel ?? null,
                      reviewThinkingLevel:
                        args.input.reviewThinkingLevel ?? null,
                      autoMerge: args.input.autoMerge,
                      includeAllIssueAuthors: args.input.includeAllIssueAuthors,
                      waitForReadyForReviewChecks:
                        args.input.waitForReadyForReviewChecks,
                    })
                    // Sync Active set (activate missing, drop unused). Prefer
                    // setSelectedOrInUse over activate so repository Saves do
                    // not retarget the process-wide proxy (harness default).
                    const selectedOrInUse =
                      yield* db.listSelectedOrInUseBackendIds
                    const backendIds = selectedOrInUse.filter(
                      (id): id is AgentBackendId =>
                        isSelectableAgentBackendId(id),
                    )
                    yield* active.setSelectedOrInUse(
                      backendIds,
                      inspectInput(agentBackendCwd),
                    )
                    return updated
                  }),
                )
                if (identityChanging) {
                  yield* suspendRepositoryPolling(updated.id).pipe(
                    Effect.andThen(
                      activatePollingIfCredentialed(updated, {
                        metadataTimeout: keymaxxerMetadataTimeout,
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.logWarning(
                        "Repository polling was not updated after Forge identity correction",
                        { repositoryId: updated.id, error },
                      ),
                    ),
                  )
                }
                return updated
              }).pipe(Effect.withSpan("graphql-api.updateRepositorySettings")),
              context,
            ),
          pauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.pauseRepository(args.repositoryId)
              }).pipe(Effect.withSpan("graphql-api.pauseRepository")),
              context,
            ),
          unpauseRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.unpauseRepository(args.repositoryId)
              }).pipe(Effect.withSpan("graphql-api.unpauseRepository")),
              context,
            ),
          addRepository: async (
            _parent: unknown,
            args: AddRepositoryArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const resolved = yield* verifyRepositoryIdentity(args.input)
                const db = yield* DbService
                const added = yield* db.addRepository({
                  ...args.input,
                  forge: resolved.forge,
                  forgeHost: resolved.forgeHost,
                  projectPath: resolved.projectPath,
                })
                yield* activatePollingIfCredentialed(added, {
                  metadataTimeout: keymaxxerMetadataTimeout,
                }).pipe(
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
              context,
            ),
          addLocalRepository: async (
            _parent: unknown,
            args: AddLocalRepositoryArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const path = args.path.trim()
                if (path.length === 0) {
                  return yield* Effect.fail(
                    new GraphQLError("Path is required", {
                      extensions: { code: "BAD_USER_INPUT" },
                    }),
                  )
                }
                const localGit = yield* LocalGit
                const db = yield* DbService
                const inspected = yield* localGit.inspect(path)
                const resolved = yield* verifyRepositoryIdentity(inspected)
                const added = yield* db.addRepository({
                  forge: resolved.forge,
                  forgeHost: resolved.forgeHost,
                  projectPath: resolved.projectPath,
                  localPath: inspected.localPath,
                  isBare: inspected.isBare,
                })
                yield* activatePollingIfCredentialed(added, {
                  metadataTimeout: keymaxxerMetadataTimeout,
                }).pipe(
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
              }).pipe(Effect.withSpan("graphql-api.addLocalRepository")),
              context,
            ),
          inspectLocalRepository: async (
            _parent: unknown,
            args: AddLocalRepositoryArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const path = args.path.trim()
                if (path.length === 0) {
                  return yield* Effect.fail(
                    new GraphQLError("Path is required", {
                      extensions: { code: "BAD_USER_INPUT" },
                    }),
                  )
                }
                const localGit = yield* LocalGit
                return yield* localGit.inspect(path)
              }).pipe(Effect.withSpan("graphql-api.inspectLocalRepository")),
              context,
            ),
          pickLocalDirectory: async (
            _parent: unknown,
            _args: unknown,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const picker = yield* DirectoryPicker
                return yield* picker.pick
              }).pipe(Effect.withSpan("graphql-api.pickLocalDirectory")),
              context,
            ),
          addRepositoryGitHubToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
            context: GraphqlRequestContext,
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
                    if (repository.forge !== "github") {
                      return yield* new RepositoryCredentialError({
                        message:
                          "addRepositoryGitHubToken is only valid for GitHub Repositories",
                      })
                    }

                    const keymaxxer = yield* KeymaxxerService
                    const account = repository.projectPath
                    const existingToken = yield* withKeymaxxerMetadataTimeout(
                      keymaxxer.findSecret({
                        provider: "github",
                        account,
                      }),
                      keymaxxerMetadataTimeout,
                      "findSecret",
                    )
                    let tokenName = existingToken
                    if (tokenName === null) {
                      tokenName = githubTokenSecretName(repository)
                      if (
                        yield* withKeymaxxerMetadataTimeout(
                          keymaxxer.hasSecret(tokenName),
                          keymaxxerMetadataTimeout,
                          "hasSecret",
                        )
                      ) {
                        return yield* new RepositoryCredentialError({
                          message: `Keymaxxer secret ${tokenName} already exists for another account`,
                        })
                      }
                      // Interactive secret entry/approval: intentionally not
                      // wrapped in the short metadata timeout. Holds
                      // tokenProvisioning until the operator finishes or cancels.
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
                      tokenName = yield* withKeymaxxerMetadataTimeout(
                        keymaxxer.findSecret({
                          provider: "github",
                          account,
                        }),
                        keymaxxerMetadataTimeout,
                        "findSecret",
                      )
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
              context,
            ),
          addRepositoryGitLabToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
            context: GraphqlRequestContext,
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
                    if (repository.forge !== "gitlab") {
                      return yield* new RepositoryCredentialError({
                        message:
                          "addRepositoryGitLabToken is only valid for GitLab Repositories",
                      })
                    }

                    const keymaxxer = yield* KeymaxxerService
                    const account = gitlabVaultAccount(repository)
                    const existingToken = yield* withKeymaxxerMetadataTimeout(
                      keymaxxer.findSecret({
                        provider: "gitlab",
                        account,
                      }),
                      keymaxxerMetadataTimeout,
                      "findSecret",
                    )
                    let tokenName = existingToken
                    if (tokenName === null) {
                      tokenName = gitlabTokenSecretName(repository)
                      if (
                        yield* withKeymaxxerMetadataTimeout(
                          keymaxxer.hasSecret(tokenName),
                          keymaxxerMetadataTimeout,
                          "hasSecret",
                        )
                      ) {
                        return yield* new RepositoryCredentialError({
                          message: `Keymaxxer secret ${tokenName} already exists for another account`,
                        })
                      }
                      // Interactive secret entry/approval: intentionally not
                      // wrapped in the short metadata timeout. Holds
                      // tokenProvisioning until the operator finishes or cancels.
                      const added = yield* keymaxxer.addSecret({
                        name: tokenName,
                        provider: "gitlab",
                        account,
                        environment: "prod",
                        access: "read-write",
                        description: `GitLab personal access token for Ready for Agent on ${account}`,
                        tags: "ready-for-agent,harness,gitlab",
                      })
                      if (!added) {
                        return yield* new RepositoryCredentialError({
                          message: "Keymaxxer GitLab token setup was cancelled",
                        })
                      }
                      tokenName = yield* withKeymaxxerMetadataTimeout(
                        keymaxxer.findSecret({
                          provider: "gitlab",
                          account,
                        }),
                        keymaxxerMetadataTimeout,
                        "findSecret",
                      )
                      if (tokenName === null) {
                        return yield* new RepositoryCredentialError({
                          message:
                            "The saved Keymaxxer secret does not match this GitLab repository",
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
                .pipe(Effect.withSpan("graphql-api.addRepositoryGitLabToken")),
              context,
            ),
          removeRepository: async (
            _parent: unknown,
            args: RemoveRepositoryArgs,
            context: GraphqlRequestContext,
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
              context,
            ),
          resetWorkItem: async (
            _parent: unknown,
            args: ResetWorkItemArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.reset(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.resetWorkItem")),
              context,
            ),
          refreshRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
            context: GraphqlRequestContext,
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

                // Accept promptly after Repository validation. Credential
                // availability and reconciliation outcomes belong to job
                // execution — do not block GraphQL on Keymaxxer dialogs.
                // Acceptance is intentionally non-blocking; the Refresh Job
                // worker may still wait on vault unlock or secret-use approval
                // while reconciling (failure/progress is job status, not this
                // mutation).
                const jobId = yield* enqueueRefreshRepositoryJob(repository.id)
                return {
                  id: jobId,
                  repositoryId: repository.id,
                }
              }).pipe(Effect.withSpan("graphql-api.refreshRepository")),
              context,
            ),
          implementNow: async (
            _parent: unknown,
            args: ImplementNowArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.implementNow(
                  args.repositoryId,
                  args.issueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.implementNow")),
              context,
            ),
          implementLocally: async (
            _parent: unknown,
            args: ImplementNowArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.implementLocally(
                  args.repositoryId,
                  args.issueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.implementLocally")),
              context,
            ),
          implementAllWithAutoMerge: async (
            _parent: unknown,
            args: ImplementNowArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.implementAllWithAutoMerge(
                  args.repositoryId,
                  args.issueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.implementAllWithAutoMerge")),
              context,
            ),
          queue: async (
            _parent: unknown,
            args: ImplementNowArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.queue(
                  args.repositoryId,
                  args.issueNumber,
                )
              }).pipe(Effect.withSpan("graphql-api.queue")),
              context,
            ),
          startRepositoryIntake: async (
            _parent: unknown,
            args: IssuesArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              startRepositoryIntake(args.repositoryId).pipe(
                Effect.withSpan("graphql-api.startRepositoryIntake"),
              ),
              context,
            ),
          retryWorkItem: async (
            _parent: unknown,
            args: WorkItemArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.retry(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.retryWorkItem")),
              context,
            ),
          pauseWorkItem: async (
            _parent: unknown,
            args: WorkItemArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.pause(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.pauseWorkItem")),
              context,
            ),
          startWorkItem: async (
            _parent: unknown,
            args: WorkItemArgs,
            context: GraphqlRequestContext,
          ) =>
            runGraphql(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                return yield* lifecycle.start(args.workItemId)
              }).pipe(Effect.withSpan("graphql-api.startWorkItem")),
              context,
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
