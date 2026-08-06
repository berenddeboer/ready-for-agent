import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect"
import {
  ActiveAgentBackend,
  type ActiveAgentBackendShape,
  type AgentBackendId,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  missingSessionTelemetry,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import { DbService, RepositoryId } from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbService,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { DirectoryPicker, LocalGit } from "@ready-for-agent/local-git"
import { QueueService } from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import {
  WorkItemLifecycle,
  type WorkItemLifecycleShape,
} from "@ready-for-agent/work-item-lifecycle"
import {
  PRODUCTION_HTTP_IDLE_TIMEOUT_SECONDS,
  startProductionLifecycle,
} from "../src/server/production-lifecycle.ts"

/**
 * GraphQL Yoga production SSE ping interval (seconds). Source of truth is
 * graphql-yoga's SSE processor (`pingIntervalMs = 12_000` when
 * `NODE_ENV !== "test"`). Update if Yoga changes that default.
 */
const YOGA_SSE_HEARTBEAT_INTERVAL_SECONDS = 12

const repository = makeRepositoryRecord({
  id: RepositoryId.make("repo-01J00000000000000000000000"),
  localPath: "/repos/acme/widgets.git",
  paused: true,
})

const unused = () => Effect.die("not used in SSE idle-timeout test")

const readyRuntimeStatus = (): AgentBackendRuntimeStatus => ({
  backend: { id: "opencode", label: "OpenCode" },
  kind: "ready",
  reason: null,
  models: [
    {
      id: "opencode/deepseek-v4-flash-free",
      thinkingLevels: ["low", "high"],
    },
  ],
  provider: null,
})

const readyStatus = (): AgentBackendStatus =>
  toAgentBackendStatus(readyRuntimeStatus())

const defaultGithub: GitHubServiceShape = {
  getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(1),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  observeAutomatedReviewEvidence: () =>
    Effect.succeed({
      _tag: "ambiguous" as const,
      reason: "Automated review evidence observation is not configured",
    }),
  getPullRequestLifecycleStatus: () => Effect.succeed({ _tag: "open" }),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  rerunWorkflowRun: () => Effect.void,
  ensureIssueCompletedWithSummary: () => Effect.void,
  listReadyIssues: () => Effect.succeed([]),
}

const defaultGitlab: GitLabServiceShape = {
  verifyProject: (repository) => Effect.succeed(repository),
  getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
  listReadyIssues: () => Effect.succeed([]),
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  markPullRequestReadyForReview: () => Effect.void,
  getPullRequestLifecycleStatus: () =>
    Effect.succeed({ _tag: "open" as const }),
  mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("failed to allocate port")
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

type SseSession = {
  readonly label: string
  readonly response: Response
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly controller: AbortController
  buffer: string
}

const openSubscription = async (
  baseUrl: string,
  label: string,
  query: string,
): Promise<SseSession> => {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}graphql`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
    signal: controller.signal,
  })
  if (!response.ok || response.body === null) {
    controller.abort()
    throw new Error(`${label} subscription returned ${response.status}`)
  }
  return {
    label,
    response,
    reader: response.body.getReader(),
    controller,
    buffer: "",
  }
}

const readUntil = async (
  session: SseSession,
  predicate: (buffer: string) => boolean,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  const decoder = new TextDecoder()
  while (!predicate(session.buffer)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `${session.label}: timed out waiting for SSE data; buffer=${JSON.stringify(session.buffer)}`,
      )
    }
    const next = await Promise.race([
      session.reader.read(),
      Bun.sleep(remaining).then(() => null),
    ])
    if (next === null) {
      throw new Error(
        `${session.label}: timed out waiting for SSE data; buffer=${JSON.stringify(session.buffer)}`,
      )
    }
    if (next.done) {
      throw new Error(
        `${session.label}: stream closed before expected data; buffer=${JSON.stringify(session.buffer)}`,
      )
    }
    session.buffer += decoder.decode(next.value, { stream: true })
  }
  return session.buffer
}

const closeSession = async (session: SseSession): Promise<void> => {
  session.controller.abort()
  try {
    await session.reader.cancel()
  } catch {
    // Reader may already be closed by abort.
  }
}

describe("production GraphQL SSE idle timeout", () => {
  const disposers: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      if (dispose === undefined) continue
      try {
        await dispose()
      } catch {
        // Always attempt remaining disposers so one failure cannot leak
        // the ManagedRuntime or HTTP server into later tests.
      }
    }
  })

  it("declares an idle timeout longer than Yoga's production heartbeat", () => {
    // Guards the production constant against accidental regression below the
    // Yoga interval documented in YOGA_SSE_HEARTBEAT_INTERVAL_SECONDS.
    expect(PRODUCTION_HTTP_IDLE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(30)
    expect(PRODUCTION_HTTP_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(
      YOGA_SSE_HEARTBEAT_INTERVAL_SECONDS,
    )
    // Bun's historical default (10s) is strictly less than Yoga's 12s ping.
    expect(YOGA_SSE_HEARTBEAT_INTERVAL_SECONDS).toBeGreaterThan(10)
  })

  it("keeps quiet Repository, Issue, and Work Item subscriptions alive across heartbeats", async () => {
    // Yoga shortens SSE pings under NODE_ENV=test (300ms). Force production
    // cadence so this exercises the real 12s heartbeat vs Bun idle timeout.
    // Restore in an outer finally so setup failures cannot leave NODE_ENV set.
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    const sessions: SseSession[] = []

    try {
      const repositoryChanges = Effect.runSync(PubSub.unbounded<void>())
      const issueChanges = Effect.runSync(PubSub.unbounded<string>())
      const workItemChanges = Effect.runSync(PubSub.unbounded<string>())

      const db = stubDbService({
        repositoryChanges: Stream.fromPubSub(repositoryChanges),
        issueChanges: Stream.fromPubSub(issueChanges),
        workItemChanges: Stream.fromPubSub(workItemChanges),
        listRepositories: Effect.succeed([repository]),
        getConfig: Effect.succeed({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        }),
      })

      const keymaxxer: KeymaxxerServiceShape = {
        initialize: Effect.void,
        findSecret: () => Effect.succeed(null),
        findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
        hasSecret: () => Effect.succeed(false),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () => Effect.die("not used"),
      }

      const ready = readyRuntimeStatus()
      const activeBackend: ActiveAgentBackendShape = {
        listStatuses: Effect.succeed([ready]),
        getBackendStatus: (backendId: AgentBackendId) =>
          Effect.succeed(backendId === ready.backend.id ? ready : null),
        getStatus: Effect.succeed(readyStatus()),
        setSelectedOrInUse: () => Effect.succeed([ready]),
        recheck: () => Effect.succeed(ready),
        requireAgentTurnsAllowed: () => Effect.void,
        activate: () => Effect.succeed(ready),
        drop: () => Effect.void,
        preview: () =>
          Effect.succeed({
            backend: { id: "opencode", label: "OpenCode" },
            kind: "ready" as const,
            reason: null,
            models: readyStatus().models,
            provider: null,
          }),
        withConfigCoordination: (effect) => effect,
        getRegistration: () =>
          Effect.succeed({
            descriptor: { id: "opencode", label: "OpenCode" },
            capabilities: [
              { _tag: "SessionTelemetry", supported: true },
              { _tag: "KeymaxxerMcp", supported: true },
            ],
          }),
        getActiveRegistration: Effect.succeed({
          descriptor: { id: "opencode", label: "OpenCode" },
          capabilities: [
            { _tag: "SessionTelemetry", supported: true },
            { _tag: "KeymaxxerMcp", supported: true },
          ],
        }),
        startTurn: () => Effect.die("unused"),
        continueTurn: () => Effect.die("unused"),
        inspectBackend: () => Effect.die("unused"),
        getSessionTelemetry: (input) =>
          Effect.succeed(
            missingSessionTelemetry(input.sessionId ?? "", {
              id: "opencode",
              label: "OpenCode",
            }),
          ),
      }

      const lifecycle: WorkItemLifecycleShape = {
        maxDurations: {
          create_worktree: Duration.minutes(5),
          install_dependencies: Duration.minutes(15),
          implement: Duration.hours(2),
          assess_changes: Duration.minutes(5),
          pre_commit: Duration.hours(2),
          review: Duration.hours(1),
          commit: Duration.minutes(5),
          create_pr: Duration.minutes(10),
          watch_pr_status_checks: Duration.minutes(5),
          resolve_pr_merge_conflict: Duration.hours(2),
          investigate_pr_status_checks: Duration.hours(2),
          mark_pr_ready_for_review: Duration.minutes(5),
          decide_pr_merge: Duration.minutes(15),
          merge_pr: Duration.minutes(5),
          close_issue: Duration.minutes(5),
          local_cleanup: Duration.minutes(5),
        },
        implementNow: unused,
        implementLocally: unused,
        implementAllWithAutoMerge: unused,
        queue: unused,
        recoverOrphanedStepRuns: Effect.succeed(0),
        interruptRunningStepRunsFromPriorWorker: Effect.succeed(0),
        runStep: unused,
        retry: unused,
        pause: unused,
        start: unused,
        abandon: unused,
        reset: unused,
        getWorkItem: unused,
        listWorkItemsForIssue: unused,
        listWorkItemsForRepository: unused,
        listCompletedWorkItems: unused,
        ownsSessionId: () => Effect.succeed(false),
        countCommittedPullRequests: unused,
        continueAfterHumanPrOutcome: unused,
        admitWaitingWorkItems: Effect.succeed(0),
        releaseWaitingForBlockers: () => Effect.succeed(0),
      }

      const runtime = ManagedRuntime.make(
        Layer.mergeAll(
          Layer.succeed(DbService, db),
          Layer.succeed(KeymaxxerService, keymaxxer),
          Layer.succeed(ActiveAgentBackend, activeBackend),
          Layer.succeed(QueueService, stubQueueService()),
          Layer.succeed(WorkItemLifecycle, lifecycle),
          Layer.succeed(GitHubService, defaultGithub),
          Layer.succeed(GitLabService, defaultGitlab),
          Layer.succeed(LocalGit, {
            inspect: () => Effect.die("unused"),
          }),
          Layer.succeed(DirectoryPicker, {
            available: Effect.succeed(false),
            pick: Effect.succeed(null),
          }),
        ),
      )
      disposers.push(async () => {
        await runtime.dispose()
      })

      const graphqlApi = createGraphqlApi(runtime)
      const port = await freePort()

      // Use the production lifecycle's default Bun.serve path (not an
      // injected serveHttp mock) so idleTimeout is the real production value.
      const handle = await startProductionLifecycle({
        waitForShutdown: false,
        hostname: "127.0.0.1",
        port,
        environment: {
          SQLITE_DATABASE_PATH: "/tmp/unused-sse-idle.db",
          KEYMAXXER_ENABLED: "false",
          NO_BROWSER: "1",
        },
        argv: ["bun", "server.ts", "--no-open"],
        applyMigrations: async () => {},
        createApplication: async () => ({
          context: { graphqlApi },
          dispose: async () => {},
        }),
        loadStartHandler: async () => ({
          fetch: async (request, { context }) => {
            if (new URL(request.url).pathname !== "/graphql") {
              return new Response("not found", { status: 404 })
            }
            return context.graphqlApi.fetch(request)
          },
        }),
        installSignalHandlers: () => () => {},
        openBrowser: () => {},
        exitProcess: () => {},
      })
      disposers.push(async () => {
        await handle.dispose()
      })

      const baseUrl = handle.url
      const foreignHost = await fetch(`http://localhost:${port}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ health }" }),
      })
      expect(foreignHost.status).toBe(421)

      const [repositoriesSession, issuesSession, workItemsSession] =
        await Promise.all([
          openSubscription(
            baseUrl,
            "repositoriesChanged",
            "subscription { repositoriesChanged }",
          ),
          openSubscription(
            baseUrl,
            "repositoryIssuesChanged",
            "subscription { repositoryIssuesChanged }",
          ),
          openSubscription(
            baseUrl,
            "repositoryWorkItemsChanged",
            "subscription { repositoryWorkItemsChanged }",
          ),
        ])
      sessions.push(repositoriesSession, issuesSession, workItemsSession)

      for (const session of sessions) {
        expect(session.response.headers.get("content-type")).toContain(
          "text/event-stream",
        )
        // Yoga always emits an immediate SSE comment ping.
        await readUntil(session, (buffer) => buffer.includes(":"), 5_000)
      }

      // Remain quiet past the former 10s Bun idle timeout and Yoga's first
      // 12s interval heartbeat. The original connections must still be open.
      const quietMs = (YOGA_SSE_HEARTBEAT_INTERVAL_SECONDS + 1) * 1_000
      await Bun.sleep(quietMs)

      for (const session of sessions) {
        await readUntil(
          session,
          (buffer) => (buffer.match(/:\n\n/g) ?? []).length >= 2,
          5_000,
        )
      }

      // Publish invalidations only after the quiet interval so delivery
      // proves the original production connections survived.
      await Effect.runPromise(PubSub.publish(repositoryChanges, undefined))
      await Effect.runPromise(PubSub.publish(issueChanges, repository.id))
      await Effect.runPromise(PubSub.publish(workItemChanges, repository.id))

      await readUntil(
        repositoriesSession,
        (buffer) => buffer.includes('"data":{"repositoriesChanged":true}'),
        5_000,
      )
      await readUntil(
        issuesSession,
        (buffer) =>
          buffer.includes(
            `"data":{"repositoryIssuesChanged":"${repository.id}"}`,
          ),
        5_000,
      )
      await readUntil(
        workItemsSession,
        (buffer) =>
          buffer.includes(
            `"data":{"repositoryWorkItemsChanged":"${repository.id}"}`,
          ),
        5_000,
      )
    } finally {
      for (const session of sessions) {
        await closeSession(session)
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
    }
  }, 60_000)
})
