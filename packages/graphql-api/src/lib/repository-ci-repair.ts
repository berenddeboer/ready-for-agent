import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Ref,
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { ulid } from "ulidx"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  SharedAgentTurnAdmission,
  WorkItemLifecycle,
  agentModelCatalogViolation,
  agentTurnForgeCredentialGuidance,
  resolveAgentModelsForBackend,
  resolveAgentTurnForgeAuth,
} from "@ready-for-agent/work-item-lifecycle"
import {
  deriveRepositoryCiGateStatus,
  observeRepositoryCiGate,
} from "./observe-repository-ci-gate.js"
import { REPAIR_SKILL } from "./repair-skill.js"

/** Four hours from actual launch. Queue time is not included. */
export const CI_REPAIR_BUDGET_MS = 4 * 60 * 60 * 1000

const POLL_INTERVAL = Duration.seconds(15)

export class CiRepairNotSupportedError extends Schema.TaggedError<CiRepairNotSupportedError>()(
  "CiRepairNotSupportedError",
  {
    message: Schema.String,
    repositoryId: Schema.String,
  },
) {}

export class CiRepairNotEligibleError extends Schema.TaggedError<CiRepairNotEligibleError>()(
  "CiRepairNotEligibleError",
  {
    message: Schema.String,
    repositoryId: Schema.String,
  },
) {}

export class CiRepairNotReadyError extends Schema.TaggedError<CiRepairNotReadyError>()(
  "CiRepairNotReadyError",
  {
    message: Schema.String,
    repositoryId: Schema.String,
  },
) {}

export class CiRepairProcessStillRunningError extends Schema.TaggedError<CiRepairProcessStillRunningError>()(
  "CiRepairProcessStillRunningError",
  {
    message: Schema.String,
    repositoryId: Schema.String,
  },
) {}

export type CiRepairStartError =
  | CiRepairNotSupportedError
  | CiRepairNotEligibleError
  | CiRepairNotReadyError
  | CiRepairProcessStillRunningError

export type RepositoryCiRepairLinkView = {
  readonly url: string
  readonly kind: "pull_request" | "remote_job"
  readonly disposition:
    | "unfinished"
    | "merged"
    | "active"
    | "completed"
    | "unknown"
}

export type RepositoryCiRepairView = {
  readonly id: string
  readonly repositoryId: string
  readonly incidentId: string
  readonly status: "queued" | "running" | "recovered" | "unresolved"
  readonly requestSource: "manual" | "automatic"
  readonly outcome: "recovered" | "failed" | "timed_out" | "interrupted" | null
  readonly admittedAt: number
  readonly launchedAt: number | null
  readonly deadlineAt: number | null
  readonly sessionId: string | null
  readonly report: string | null
  readonly links: readonly RepositoryCiRepairLinkView[]
  readonly localExecutionStopped: boolean
}

export type CiRepairExecution = {
  readonly processRef: string
  readonly cwd: string
  readonly prompt: string
  readonly backendId: AgentBackendId
  readonly model: string
  readonly thinkingLevel: string | null
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly onSessionId: (sessionId: string) => Effect.Effect<void>
}

export type CiRepairExecutionResult = {
  readonly sessionId: string
  readonly assistantText: string
}

/**
 * The process that runs the build agent. `kill` must stop local execution
 * even when `run` does not honor interruption. `stopped` is how restart
 * proves the previous process is gone.
 */
export class CiRepairExecutor extends Context.Service<
  CiRepairExecutor,
  {
    readonly run: (
      input: CiRepairExecution,
    ) => Effect.Effect<CiRepairExecutionResult, unknown>
    readonly kill: (processRef: string) => Effect.Effect<void>
    readonly stopped: (processRef: string | null) => Effect.Effect<boolean>
  }
>()("@ready-for-agent/graphql-api/CiRepairExecutor") {}

/** Services a start or drive needs when it re-observes the gate. */
type CiRepairCallContext =
  | DbService
  | WorkItemLifecycle
  | GitHubService
  | GitLabService
  | AzureDevOpsService
  | KeymaxxerService
  | ActiveAgentBackend

export type RepositoryCiRepairShape = {
  readonly startManual: (
    repositoryId: string,
  ) => Effect.Effect<
    RepositoryCiRepairView,
    CiRepairStartError | unknown,
    CiRepairCallContext
  >
  readonly drive: (
    invocationId: string,
  ) => Effect.Effect<void, unknown, CiRepairCallContext>
  readonly latestForRepository: (
    repositoryId: string,
  ) => Effect.Effect<RepositoryCiRepairView | null, unknown>
  /**
   * Enqueue the shared repair for a confirmed Closed incident when the
   * Repository has opted in. Returns null when automatic selection does not
   * apply. Does not consume the incident's single automatic attempt unless a
   * repair is admitted.
   */
  readonly considerAutomatic: (
    repositoryId: string,
  ) => Effect.Effect<RepositoryCiRepairView | null, unknown>
  readonly reconcile: () => Effect.Effect<
    {
      readonly blockedRepositoryIds: readonly string[]
    },
    unknown
  >
}

const unavailableRepair: RepositoryCiRepairShape = {
  startManual: (repositoryId) =>
    Effect.fail(
      new CiRepairNotReadyError({
        repositoryId,
        message: "Repository CI repair is not available in this process.",
      }),
    ),
  drive: () => Effect.void,
  latestForRepository: () => Effect.succeed(null),
  considerAutomatic: () => Effect.succeed(null),
  reconcile: () => Effect.succeed({ blockedRepositoryIds: [] }),
}

/**
 * Default is a refusal. The harness provides the live service. Callers that
 * never start repair do not need the supervisor in context.
 */
export const RepositoryCiRepair = Context.Reference<RepositoryCiRepairShape>(
  "@ready-for-agent/graphql-api/RepositoryCiRepair",
  { defaultValue: () => unavailableRepair },
)

type InvocationRow = {
  readonly id: string
  readonly repository_id: string
  readonly incident_id: string
  readonly status: RepositoryCiRepairView["status"]
  readonly request_source: RepositoryCiRepairView["requestSource"]
  readonly outcome: RepositoryCiRepairView["outcome"]
  readonly supervisor_epoch: string
  readonly admitted_at: number
  readonly launched_at: number | null
  readonly deadline_at: number | null
  readonly session_id: string | null
  readonly process_ref: string | null
  readonly report: string | null
}

type LinkRow = {
  readonly url: string
  readonly kind: RepositoryCiRepairLinkView["kind"]
  readonly disposition: RepositoryCiRepairLinkView["disposition"]
}

type GatePicture = {
  readonly status: "disabled" | "open" | "closed" | "degraded"
  readonly incidentId: string | null
  readonly incidentSummary: string | null
  readonly defaultBranch: string | null
  readonly definitions: readonly {
    readonly identity: string
    readonly displayLabel: string
    readonly diagnostic: string | null
    readonly htmlUrl: string | null
    readonly rawConclusion: string | null
    readonly headSha: string | null
  }[]
}

const evidenceDirectory = (invocationId: string): string =>
  join(tmpdir(), "rfa-ci-repair", invocationId)

const isUniqueActiveViolation = (error: unknown): boolean => {
  const message = String(error).toLowerCase()
  return (
    message.includes("ci_repair_invocation_one_active_uidx") ||
    (message.includes("unique") && message.includes("ci_repair_invocation"))
  )
}

const parseLinks = (
  text: string,
): readonly Omit<RepositoryCiRepairLinkView, never>[] => {
  const found = new Map<string, RepositoryCiRepairLinkView>()
  // Explicit lines are a log. The latest line for a URL wins. A bare pull
  // request URL only fills a URL that no explicit line recorded, so it cannot
  // turn a later merged or completed line back into unfinished work.
  const add = (link: RepositoryCiRepairLinkView, mode: "replace" | "fill") => {
    if (mode === "replace" || !found.has(link.url)) found.set(link.url, link)
  }
  for (const line of text.split("\n")) {
    const pullRequest =
      /^CI_REPAIR_PR\s+(\S+)\s+(unfinished|merged|unknown)\s*$/.exec(
        line.trim(),
      )
    const pullRequestDisposition = pullRequest?.[2]
    if (
      pullRequest?.[1] !== undefined &&
      (pullRequestDisposition === "unfinished" ||
        pullRequestDisposition === "merged" ||
        pullRequestDisposition === "unknown")
    ) {
      add(
        {
          url: pullRequest[1],
          kind: "pull_request",
          disposition: pullRequestDisposition,
        },
        "replace",
      )
      continue
    }
    const job = /^CI_REPAIR_JOB\s+(\S+)\s+(active|completed|unknown)\s*$/.exec(
      line.trim(),
    )
    const jobDisposition = job?.[2]
    if (
      job?.[1] !== undefined &&
      (jobDisposition === "active" ||
        jobDisposition === "completed" ||
        jobDisposition === "unknown")
    ) {
      add(
        {
          url: job[1],
          kind: "remote_job",
          disposition: jobDisposition,
        },
        "replace",
      )
    }
  }
  for (const match of text.matchAll(
    /https:\/\/github\.com\/[^\s)"]+\/pull\/\d+/g,
  )) {
    const url = match[0]
    if (url !== undefined) {
      add({ url, kind: "pull_request", disposition: "unfinished" }, "fill")
    }
  }
  return [...found.values()]
}

const writeText = (path: string, body: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
    },
    catch: (cause) => cause,
  }).pipe(Effect.ignore)

const readText = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => "",
  }).pipe(Effect.orElseSucceed(() => ""))

const deliverSkillFiles = (cwd: string) =>
  Effect.gen(function* () {
    const targets = [
      join(cwd, ".agents", "skills", "repair-ci-cd-pipeline", "SKILL.md"),
      join(cwd, ".claude", "skills", "repair-ci-cd-pipeline", "SKILL.md"),
    ]
    for (const target of targets) {
      yield* writeText(target, REPAIR_SKILL)
    }
  })

/**
 * Production executor: one build-agent turn through the selected backend.
 * The turn timeout and `kill` both end local execution. `kill` wins even
 * when the turn does not cooperate, because the agent runner's scope
 * finalizer destroys the invocation cgroup on interruption.
 */
export const CiRepairExecutorLive = Layer.effect(
  CiRepairExecutor,
  Effect.gen(function* () {
    const active = yield* ActiveAgentBackend
    const aborts = yield* Ref.make(new Map<string, Deferred.Deferred<void>>())
    const live = yield* Ref.make(new Set<string>())
    const forget = (processRef: string) =>
      Effect.gen(function* () {
        yield* Ref.update(aborts, (map) => {
          const next = new Map(map)
          next.delete(processRef)
          return next
        })
        yield* Ref.update(live, (set) => {
          const next = new Set(set)
          next.delete(processRef)
          return next
        })
      })
    return CiRepairExecutor.of({
      run: (input) =>
        Effect.gen(function* () {
          yield* deliverSkillFiles(input.cwd)
          const abort = yield* Deferred.make<void>()
          yield* Ref.update(aborts, (map) =>
            new Map(map).set(input.processRef, abort),
          )
          yield* Ref.update(live, (set) => new Set(set).add(input.processRef))
          return yield* active
            .startTurn(input.backendId, {
              prompt: input.prompt,
              cwd: input.cwd,
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              timeout: Duration.millis(Math.max(1, input.timeoutMs)),
              onSessionId: input.onSessionId,
            })
            .pipe(
              Effect.raceFirst(
                Deferred.await(abort).pipe(
                  Effect.andThen(
                    Effect.fail(new Error("CI repair execution was stopped")),
                  ),
                ),
              ),
            )
        }).pipe(Effect.ensuring(forget(input.processRef))),
      kill: (processRef) =>
        Effect.gen(function* () {
          const abort = (yield* Ref.get(aborts)).get(processRef)
          if (abort !== undefined) {
            yield* Deferred.succeed(abort, undefined).pipe(Effect.ignore)
          }
          yield* Ref.update(live, (set) => {
            const next = new Set(set)
            next.delete(processRef)
            return next
          })
        }),
      stopped: (processRef) =>
        Effect.gen(function* () {
          if (processRef === null) return true
          return !(yield* Ref.get(live)).has(processRef)
        }),
    })
  }),
)

const buildPrompt = (input: {
  readonly repository: RepositoryRecord
  readonly gate: GatePicture
  readonly deadlineAt: number
  readonly credentialGuidance: string
  readonly backendLabel: string
  readonly model: string
  readonly previousLinks: readonly RepositoryCiRepairLinkView[]
  readonly evidenceDir: string
  readonly requestSource: RepositoryCiRepairView["requestSource"]
}): string => {
  const deadline = new Date(input.deadlineAt).toISOString()
  const definitions = input.gate.definitions
    .map((definition) =>
      [
        `- ${definition.displayLabel} (${definition.identity})`,
        definition.rawConclusion !== null
          ? `conclusion ${definition.rawConclusion}`
          : null,
        definition.headSha !== null ? `sha ${definition.headSha}` : null,
        definition.htmlUrl,
        definition.diagnostic,
      ]
        .filter((part) => part !== null && part !== "")
        .join(" · "),
    )
    .join("\n")
  const unfinished = input.previousLinks
    .filter(
      (link) =>
        link.kind === "pull_request" &&
        (link.disposition === "unfinished" || link.disposition === "unknown"),
    )
    .map((link) => `- ${link.url}`)
    .join("\n")
  return [
    `You are the single build agent for one ${input.requestSource} repository CI repair.`,
    `Backend: ${input.backendLabel}. Build model: ${input.model}. Do not switch to a review model. There is no pull-request cap and no round cap.`,
    "Broad repair authority: change application code, CI, infrastructure, credentials, and repository settings as needed; rerun jobs; create and merge successive pull requests. Stay within the supplied credentials. Credential or platform refusals are real constraints — report them instead of inventing access.",
    `Absolute deadline: ${deadline}. This covers diagnosis, commands, pull requests, merges, and watching. Stop local work at that instant even if a remote job is still running.`,
    "The harness gate observer is authoritative. Your own exit, a green local command, a green pull request, or one green workflow does not mean the gate reopened. Stop when the snapshot below reports the gate open, including when someone else fixed it.",
    "",
    "Repository",
    `- forge: ${input.repository.forge}`,
    `- host: ${input.repository.forgeHost}`,
    `- project: ${input.repository.projectPath}`,
    `- local path: ${input.repository.localPath}`,
    `- bare: ${input.repository.isBare ? "yes" : "no"}`,
    `- default branch: ${input.gate.defaultBranch ?? "unknown"}`,
    input.repository.isBare
      ? "This checkout is bare. Create an isolated worktree from the default branch before editing."
      : "Work in this checkout. Use an isolated repair branch from the current default branch.",
    "",
    "Credential context",
    input.credentialGuidance,
    "",
    "Current gate",
    `- status: ${input.gate.status}`,
    `- incident: ${input.gate.incidentId ?? "none"}`,
    `- summary: ${input.gate.incidentSummary ?? "none"}`,
    definitions.length > 0 ? definitions : "- no definitions",
    `The supervisor refreshes authoritative gate observation at ${join(input.evidenceDir, "gate.json")}. Read that file before publishing a fix and while watching.`,
    "",
    "Unfinished pull requests from earlier attempts",
    unfinished.length > 0 ? unfinished : "- none recorded",
    "",
    "Progress",
    `Append one line at a time to ${join(input.evidenceDir, "progress.log")} so interruption keeps the evidence. A later line for the same URL replaces the earlier disposition:`,
    "CI_REPAIR_PR <url> unfinished|merged|unknown",
    "CI_REPAIR_JOB <url> active|completed|unknown",
    "Do not commit the delivered repair skill files.",
    "",
    "Operating skill (repair-ci-cd-pipeline)",
    REPAIR_SKILL,
  ].join("\n")
}

const reportFor = (input: {
  readonly outcome: NonNullable<RepositoryCiRepairView["outcome"]>
  readonly gateStatus: string
  readonly links: readonly RepositoryCiRepairLinkView[]
  readonly agentText: string
  readonly detail: string
}): string => {
  const unfinished = input.links.filter(
    (link) =>
      link.kind === "pull_request" &&
      (link.disposition === "unfinished" || link.disposition === "unknown"),
  )
  const activeJobs = input.links.filter(
    (link) => link.kind === "remote_job" && link.disposition === "active",
  )
  const lines = [
    "Local execution: stopped.",
    input.outcome === "recovered"
      ? "The harness gate observer reopened the gate. That is the recovery signal."
      : `Outcome: ${input.outcome.replaceAll("_", " ")}. The CI gate is still ${input.gateStatus}. An explicit retry is required for another attempt.`,
    input.detail,
    unfinished.length > 0
      ? `Unfinished pull requests (these may still be open after local execution stopped):\n${unfinished.map((link) => link.url).join("\n")}`
      : "Unfinished pull requests: none recorded.",
    activeJobs.length > 0
      ? `Active remote jobs (these may still be running after local execution stopped):\n${activeJobs.map((link) => link.url).join("\n")}`
      : "Active remote jobs: none recorded.",
  ]
  if (input.agentText.trim() !== "") {
    lines.push(`Agent report:\n${input.agentText.trim()}`)
  }
  return lines.join("\n\n")
}

export const makeRepositoryCiRepair = (options?: {
  readonly autoDrive?: boolean
  readonly epoch?: string
  readonly pollInterval?: Duration.Duration
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const admission = yield* SharedAgentTurnAdmission
    const active = yield* ActiveAgentBackend
    const keymaxxer = yield* KeymaxxerService
    const lifecycle = yield* WorkItemLifecycle
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azure = yield* AzureDevOpsService
    const executor = yield* CiRepairExecutor
    const epoch = options?.epoch ?? `epoch-${ulid()}`
    const autoDrive = options?.autoDrive ?? true
    const pollInterval = options?.pollInterval ?? POLL_INTERVAL
    const blocked = yield* Ref.make(new Set<string>())

    const loadRow = (id: string) =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
                  admitted_at, launched_at, deadline_at, session_id, process_ref, report
           FROM ci_repair_invocation WHERE id = ?`,
          [id],
        )) as readonly InvocationRow[]
        return rows[0] ?? null
      })

    const loadLinks = (invocationId: string) =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT url, kind, disposition
           FROM ci_repair_invocation_link
           WHERE invocation_id = ?
           ORDER BY created_at ASC`,
          [invocationId],
        )) as readonly LinkRow[]
        return rows
      })

    const toView = (row: InvocationRow) =>
      Effect.gen(function* () {
        const links = yield* loadLinks(row.id)
        const view: RepositoryCiRepairView = {
          id: row.id,
          repositoryId: row.repository_id,
          incidentId: row.incident_id,
          status: row.status,
          requestSource: row.request_source,
          outcome: row.outcome,
          admittedAt: row.admitted_at,
          launchedAt: row.launched_at,
          deadlineAt: row.deadline_at,
          sessionId: row.session_id,
          report: row.report,
          links,
          localExecutionStopped:
            row.status === "recovered" || row.status === "unresolved",
        }
        return view
      })

    const requireRepository = (repositoryId: string) =>
      Effect.gen(function* () {
        const repository = (yield* db.listRepositories).find(
          (candidate) => candidate.id === repositoryId,
        )
        if (repository === undefined) {
          return yield* new CiRepairNotEligibleError({
            repositoryId,
            message: `Repository ${repositoryId} was not found.`,
          })
        }
        return repository
      })

    const pictureGate = (repository: RepositoryRecord) =>
      Effect.gen(function* () {
        yield* observeRepositoryCiGate({ repository, origin: "operator" })
        const definitions = yield* db.listCiGateDefinitions(repository.id)
        const snapshot = yield* db.loadCiGateSnapshot(repository.id)
        const status = deriveRepositoryCiGateStatus({
          selectedCount: definitions.length,
          observations: snapshot.observations,
        })
        const byIdentity = new Map(
          snapshot.observations.map((observation) => [
            observation.identity,
            observation,
          ]),
        )
        const gate: GatePicture = {
          status,
          incidentId: snapshot.activeIncident?.id ?? null,
          incidentSummary: snapshot.activeIncident?.summary ?? null,
          defaultBranch: snapshot.state?.defaultBranch ?? null,
          definitions: definitions.map((definition) => {
            const observation = byIdentity.get(definition.identity)
            return {
              identity: definition.identity,
              displayLabel: definition.displayLabel,
              diagnostic: observation?.observationError ?? null,
              htmlUrl: observation?.lastRunHtmlUrl ?? null,
              rawConclusion: observation?.lastRawConclusion ?? null,
              headSha: observation?.lastHeadSha ?? null,
            }
          }),
        }
        return gate
      })

    const sameClosedIncident = (gate: GatePicture, incidentId: string) =>
      gate.status === "closed" && gate.incidentId === incidentId

    const upsertLinks = (
      invocationId: string,
      links: readonly RepositoryCiRepairLinkView[],
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const link of links) {
          yield* sql
            .unsafe(
              `INSERT INTO ci_repair_invocation_link
                 (id, invocation_id, url, kind, disposition, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(invocation_id, url) DO UPDATE SET
                 kind = excluded.kind,
                 disposition = excluded.disposition`,
              [
                `cril-${ulid()}`,
                invocationId,
                link.url,
                link.kind,
                link.disposition,
                now,
              ],
            )
            .pipe(Effect.ignore)
        }
      })

    const finish = (input: {
      readonly id: string
      readonly status: "recovered" | "unresolved"
      readonly outcome: NonNullable<RepositoryCiRepairView["outcome"]>
      readonly report: string
    }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* sql.unsafe(
          `UPDATE ci_repair_invocation
           SET status = ?, outcome = ?, report = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
          [input.status, input.outcome, input.report, now, input.id],
        )
      })

    const finishQueued = (input: {
      readonly id: string
      readonly status: "recovered" | "unresolved"
      readonly outcome: NonNullable<RepositoryCiRepairView["outcome"]>
      readonly report: string
    }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* sql.unsafe(
          `UPDATE ci_repair_invocation
           SET status = ?, outcome = ?, report = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
          [input.status, input.outcome, input.report, now, input.id],
        )
      })

    /**
     * Continue only while this invocation's incident is still the Closed one.
     * Recovery is the observer leaving Closed. A replacement Closed incident
     * ends the attempt without calling it recovered.
     */
    const endUnlessSameClosedIncident = (input: {
      readonly id: string
      readonly gate: GatePicture
      readonly incidentId: string
      readonly phase: "queued" | "running"
      readonly links: readonly RepositoryCiRepairLinkView[]
      readonly agentText: string
      readonly recoveredDetail: string
    }) =>
      Effect.gen(function* () {
        if (sameClosedIncident(input.gate, input.incidentId)) {
          return "continue" as const
        }
        const recovered = input.gate.status !== "closed"
        const finishWith = input.phase === "queued" ? finishQueued : finish
        yield* finishWith({
          id: input.id,
          status: recovered ? "recovered" : "unresolved",
          outcome: recovered ? "recovered" : "failed",
          report: reportFor({
            outcome: recovered ? "recovered" : "failed",
            gateStatus: input.gate.status,
            links: input.links,
            agentText: input.agentText,
            detail: recovered
              ? input.recoveredDetail
              : "The gate observer still reports Closed on a different incident. This attempt did not recover the gate.",
          }),
        })
        return "ended" as const
      })

    const activeRow = (repositoryId: string) =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
                  admitted_at, launched_at, deadline_at, session_id, process_ref, report
           FROM ci_repair_invocation
           WHERE repository_id = ? AND status IN ('queued', 'running')
           LIMIT 1`,
          [repositoryId],
        )) as readonly InvocationRow[]
        return rows[0] ?? null
      })

    const resolveLaunch = (repository: RepositoryRecord) =>
      Effect.gen(function* () {
        const config = yield* db.getConfig
        const backendId =
          repository.selectedAgentBackend ?? config.selectedAgentBackend
        if (!isSelectableAgentBackendId(backendId)) {
          return yield* new CiRepairNotReadyError({
            repositoryId: repository.id,
            message: `Agent backend ${backendId} is not selectable.`,
          })
        }
        const readiness = yield* active.getBackendStatus(backendId)
        if (readiness === null || readiness.kind !== "ready") {
          return yield* new CiRepairNotReadyError({
            repositoryId: repository.id,
            message:
              readiness?.reason ??
              (readiness === null
                ? "Agent backend is not active."
                : "Agent backend is unavailable."),
          })
        }
        const selection = yield* resolveAgentModelsForBackend(
          repository.id,
          backendId,
        )
        const violation = agentModelCatalogViolation({
          backendLabel: readiness.backend.label,
          catalogModelIds: readiness.models.map((model) => model.id),
          selection,
          includeReviewModel: false,
        })
        if (violation !== null) {
          return yield* new CiRepairNotReadyError({
            repositoryId: repository.id,
            message: violation,
          })
        }
        const auth = yield* resolveAgentTurnForgeAuth({
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
        })
        return {
          backendId,
          backendLabel: readiness.backend.label,
          model: selection.model,
          thinkingLevel: selection.thinkingLevel,
          credentialGuidance: agentTurnForgeCredentialGuidance(
            repository,
            auth,
            "GitHub Actions, pull requests, merges, workflow reruns, checks, and repository administration",
          ),
        }
      })

    const collectEvidence = (invocationId: string, agentText: string) =>
      Effect.gen(function* () {
        const progress = yield* readText(
          join(evidenceDirectory(invocationId), "progress.log"),
        )
        const links = parseLinks(`${progress}\n${agentText}`)
        yield* upsertLinks(invocationId, links)
        return links
      })

    const writeGateFile = (invocationId: string, gate: GatePicture) =>
      writeText(
        join(evidenceDirectory(invocationId), "gate.json"),
        JSON.stringify(gate, null, 2),
      )

    const executeRunningWithReport = (input: {
      readonly row: InvocationRow
      readonly repository: RepositoryRecord
      readonly launch: {
        readonly backendId: AgentBackendId
        readonly backendLabel: string
        readonly model: string
        readonly thinkingLevel: string | null
        readonly credentialGuidance: string
      }
      readonly deadlineAt: number
      readonly processRef: string
    }) =>
      Effect.gen(function* () {
        const captured = yield* Ref.make("")
        const gate = yield* pictureGate(input.repository)
        yield* writeGateFile(input.row.id, gate)
        const beforeStart = yield* endUnlessSameClosedIncident({
          id: input.row.id,
          gate,
          incidentId: input.row.incident_id,
          phase: "running",
          links: yield* collectEvidence(input.row.id, ""),
          agentText: "",
          recoveredDetail:
            "The incident resolved after a slot was acquired and before the agent started. No repair agent was launched.",
        })
        if (beforeStart === "ended") return
        const previousRows = (yield* sql.unsafe(
          `SELECT id FROM ci_repair_invocation
           WHERE repository_id = ? AND incident_id = ? AND id <> ?`,
          [input.repository.id, input.row.incident_id, input.row.id],
        )) as readonly { readonly id: string }[]
        const previousLinks: RepositoryCiRepairLinkView[] = []
        for (const previous of previousRows) {
          previousLinks.push(...(yield* loadLinks(previous.id)))
        }
        const prompt = buildPrompt({
          repository: input.repository,
          gate,
          deadlineAt: input.deadlineAt,
          credentialGuidance: input.launch.credentialGuidance,
          backendLabel: input.launch.backendLabel,
          model: input.launch.model,
          previousLinks,
          evidenceDir: evidenceDirectory(input.row.id),
          requestSource: input.row.request_source,
        })
        const now = yield* Clock.currentTimeMillis
        const timeoutMs = Math.max(1, input.deadlineAt - now)
        const deadlineHit = yield* Ref.make(false)
        const onSessionId = (sessionId: string) =>
          Effect.gen(function* () {
            const updatedAt = yield* Clock.currentTimeMillis
            yield* sql.unsafe(
              `UPDATE ci_repair_invocation SET session_id = ?, updated_at = ? WHERE id = ?`,
              [sessionId, updatedAt, input.row.id],
            )
          }).pipe(Effect.asVoid, Effect.ignore)
        const execution = executor
          .run({
            processRef: input.processRef,
            cwd: input.repository.localPath,
            prompt,
            backendId: input.launch.backendId,
            model: input.launch.model,
            thinkingLevel: input.launch.thinkingLevel,
            timeoutMs,
            deadlineAt: input.deadlineAt,
            onSessionId,
          })
          .pipe(
            Effect.tap((result) => Ref.set(captured, result.assistantText)),
            Effect.asVoid,
            Effect.ignore,
          )
        const poll = Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(pollInterval)
            const latest = yield* pictureGate(input.repository)
            yield* writeGateFile(input.row.id, latest)
            yield* collectEvidence(input.row.id, yield* Ref.get(captured))
            if (
              latest.status !== "closed" ||
              latest.incidentId !== input.row.incident_id
            ) {
              yield* executor.kill(input.processRef)
              return
            }
          }
        })
        const deadline = Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(timeoutMs))
          yield* Ref.set(deadlineHit, true)
          yield* executor.kill(input.processRef)
        })
        // The watcher must not win the race. A winning sleep would interrupt
        // the agent before its report is captured, and a non-cooperating turn
        // is stopped by kill rather than by that interrupt.
        const watcher = Effect.race(poll.pipe(Effect.asVoid), deadline).pipe(
          Effect.andThen(executor.kill(input.processRef)),
          Effect.andThen(Effect.never),
        )
        yield* Effect.race(execution, watcher).pipe(Effect.ignore)
        yield* executor.kill(input.processRef)
        const agentText = yield* Ref.get(captured)
        const links = yield* collectEvidence(input.row.id, agentText)
        const finalGate = yield* pictureGate(input.repository)
        const observerEnded = yield* endUnlessSameClosedIncident({
          id: input.row.id,
          gate: finalGate,
          incidentId: input.row.incident_id,
          phase: "running",
          links,
          agentText,
          recoveredDetail:
            "Recovery was established by the gate observer, including recovery by another actor. Agent exit alone did not clear the gate.",
        })
        if (observerEnded === "ended") return
        if (yield* Ref.get(deadlineHit)) {
          yield* finish({
            id: input.row.id,
            status: "unresolved",
            outcome: "timed_out",
            report: reportFor({
              outcome: "timed_out",
              gateStatus: finalGate.status,
              links,
              agentText,
              detail:
                "The supervisor stopped local execution at the four-hour deadline even if the agent or a watch was still running. Remote jobs and unfinished pull requests were left in place.",
            }),
          })
          return
        }
        yield* finish({
          id: input.row.id,
          status: "unresolved",
          outcome: "failed",
          report: reportFor({
            outcome: "failed",
            gateStatus: finalGate.status,
            links,
            agentText,
            detail:
              "Local execution stopped while the gate observer still reports Closed. A green agent claim, pull request, or single workflow did not clear it.",
          }),
        })
      })

    const drive = (invocationId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRow(invocationId)
        if (row === null || row.status !== "queued") return
        if (row.supervisor_epoch !== epoch) return
        const repository = yield* requireRepository(row.repository_id).pipe(
          Effect.catch((error) =>
            finishQueued({
              id: row.id,
              status: "unresolved",
              outcome: "failed",
              report: `Local execution: stopped.\n\n${String(error)}`,
            }).pipe(Effect.as(null)),
          ),
        )
        if (repository === null) return
        const gate = yield* pictureGate(repository).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              _tag: "error" as const,
              message: String(error),
            }),
          ),
        )
        if ("_tag" in gate) {
          yield* finishQueued({
            id: row.id,
            status: "unresolved",
            outcome: "failed",
            report: reportFor({
              outcome: "failed",
              gateStatus: "unknown",
              links: [],
              agentText: "",
              detail: gate.message,
            }),
          })
          return
        }
        const queuedEnded = yield* endUnlessSameClosedIncident({
          id: row.id,
          gate,
          incidentId: row.incident_id,
          phase: "queued",
          links: [],
          agentText: "",
          recoveredDetail:
            "The incident resolved while this repair was queued. No agent was launched.",
        })
        if (queuedEnded === "ended") return
        const launch = yield* resolveLaunch(repository).pipe(Effect.result)
        if (launch._tag === "Failure") {
          yield* finishQueued({
            id: row.id,
            status: "unresolved",
            outcome: "failed",
            report: reportFor({
              outcome: "failed",
              gateStatus: gate.status,
              links: [],
              agentText: "",
              detail: String(launch.failure),
            }),
          })
          return
        }
        yield* admission.withPermit(
          repository.id,
          Effect.gen(function* () {
            const current = yield* loadRow(row.id)
            if (current === null || current.status !== "queued") return
            const again = yield* pictureGate(repository)
            const waitingEnded = yield* endUnlessSameClosedIncident({
              id: row.id,
              gate: again,
              incidentId: row.incident_id,
              phase: "queued",
              links: [],
              agentText: "",
              recoveredDetail:
                "The incident resolved while this repair was waiting for an agent slot. No agent was launched.",
            })
            if (waitingEnded === "ended") return
            const launchedAt = yield* Clock.currentTimeMillis
            const deadlineAt = launchedAt + CI_REPAIR_BUDGET_MS
            const processRef = `cirp-${ulid()}`
            const claimed = (yield* sql.unsafe(
              `UPDATE ci_repair_invocation
               SET status = 'running',
                   launched_at = ?,
                   deadline_at = ?,
                   process_ref = ?,
                   updated_at = ?
               WHERE id = ? AND status = 'queued'
               RETURNING id`,
              [launchedAt, deadlineAt, processRef, launchedAt, row.id],
            )) as readonly { readonly id: string }[]
            if (claimed.length === 0) return
            const running = yield* loadRow(row.id)
            if (running === null) return
            yield* executeRunningWithReport({
              row: running,
              repository,
              launch: launch.success,
              deadlineAt,
              processRef,
            }).pipe(
              Effect.catch((error) =>
                finish({
                  id: row.id,
                  status: "unresolved",
                  outcome: "failed",
                  report: reportFor({
                    outcome: "failed",
                    gateStatus: "closed",
                    links: [],
                    agentText: "",
                    detail: `Local execution stopped because the supervisor failed: ${String(error)}`,
                  }),
                }).pipe(Effect.asVoid),
              ),
            )
          }),
        )
      }).pipe(Effect.ignore, Effect.asVoid)

    const reconcile = () =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
                admitted_at, launched_at, deadline_at, session_id, process_ref, report
         FROM ci_repair_invocation
         WHERE status IN ('queued', 'running') AND supervisor_epoch <> ?`,
          [epoch],
        )) as readonly InvocationRow[]
        const stillBlocked = new Set<string>()
        for (const row of rows) {
          if (row.status === "running") {
            const stopped = yield* executor.stopped(row.process_ref)
            if (!stopped) {
              stillBlocked.add(row.repository_id)
              continue
            }
          }
          const now = yield* Clock.currentTimeMillis
          const links = yield* loadLinks(row.id)
          yield* sql.unsafe(
            `UPDATE ci_repair_invocation
           SET status = 'unresolved',
               outcome = 'interrupted',
               report = ?,
               updated_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
            [
              reportFor({
                outcome: "interrupted",
                gateStatus: "closed",
                links,
                agentText: row.report ?? "",
                detail:
                  row.status === "queued"
                    ? "Restart did not resume this queued repair. Start it again explicitly."
                    : "Restart reconciled this repair as interrupted after confirming the previous local process had stopped. It was not resumed. Unfinished pull requests and active remote jobs may still exist.",
              }),
              now,
              row.id,
            ],
          )
        }
        yield* Ref.set(blocked, stillBlocked)
        return { blockedRepositoryIds: [...stillBlocked] }
      })

    const latestForRepository = (repositoryId: string) =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
                  admitted_at, launched_at, deadline_at, session_id, process_ref, report
           FROM ci_repair_invocation
           WHERE repository_id = ?
           ORDER BY admitted_at DESC
           LIMIT 1`,
          [repositoryId],
        )) as readonly InvocationRow[]
        const row = rows[0]
        if (row === undefined) return null
        return yield* toView(row)
      })

    const invocationColumns = `id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
            admitted_at, launched_at, deadline_at, session_id, process_ref, report`

    /**
     * One queued or running repair per Repository. Any admission consumes the
     * incident's automatic-attempt eligibility in the same transaction as the
     * insert, so a failed insert does not burn it. An active repair for a
     * different incident does not consume this incident.
     */
    const admit = (input: {
      readonly repositoryId: string
      readonly incidentId: string
      readonly requestSource: RepositoryCiRepairView["requestSource"]
    }) =>
      Effect.gen(function* () {
        const committed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const activeRows = (yield* sql.unsafe(
                `SELECT ${invocationColumns}
                 FROM ci_repair_invocation
                 WHERE repository_id = ? AND status IN ('queued', 'running')
                 LIMIT 1`,
                [input.repositoryId],
              )) as readonly InvocationRow[]
              const active = activeRows[0]
              if (active !== undefined) {
                if (active.incident_id === input.incidentId) {
                  return { _tag: "existing" as const, row: active }
                }
                return { _tag: "blocked" as const }
              }
              if (input.requestSource === "automatic") {
                const consumed = (yield* sql.unsafe(
                  `UPDATE ci_failure_incident
                   SET automatic_repair_eligible = 0
                   WHERE id = ? AND automatic_repair_eligible = 1
                   RETURNING id`,
                  [input.incidentId],
                )) as readonly { readonly id: string }[]
                if (consumed.length === 0) {
                  return { _tag: "ineligible" as const }
                }
              } else {
                yield* sql.unsafe(
                  `UPDATE ci_failure_incident
                   SET automatic_repair_eligible = 0
                   WHERE id = ?`,
                  [input.incidentId],
                )
              }
              const id = `criv-${ulid()}`
              const admittedAt = yield* Clock.currentTimeMillis
              const inserted = (yield* sql.unsafe(
                `INSERT INTO ci_repair_invocation
                   (id, repository_id, incident_id, status, request_source, outcome, supervisor_epoch,
                    admitted_at, launched_at, deadline_at, session_id, process_ref, report,
                    created_at, updated_at)
                 VALUES (?, ?, ?, 'queued', ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
                 RETURNING ${invocationColumns}`,
                [
                  id,
                  input.repositoryId,
                  input.incidentId,
                  input.requestSource,
                  epoch,
                  admittedAt,
                  admittedAt,
                  admittedAt,
                ],
              )) as readonly InvocationRow[]
              const row = inserted[0]
              if (row === undefined) {
                return yield* Effect.die(
                  "CI repair insert did not return a row",
                )
              }
              return { _tag: "created" as const, row }
            }),
          )
          .pipe(
            Effect.catch((error: unknown) =>
              isUniqueActiveViolation(error)
                ? Effect.succeed({ _tag: "conflict" as const })
                : Effect.fail(error),
            ),
          )
        if (committed._tag !== "conflict") {
          return committed
        }
        const raced = yield* activeRow(input.repositoryId)
        if (raced !== null && raced.incident_id === input.incidentId) {
          return { _tag: "existing" as const, row: raced }
        }
        return { _tag: "blocked" as const }
      })

    const forkDrive = (invocationId: string) =>
      drive(invocationId).pipe(
        Effect.catch((error) =>
          Effect.logError("Repository CI repair drive failed", {
            invocationId,
            error: String(error),
          }),
        ),
        Effect.forkDetach,
      )

    const startManual = (repositoryId: string) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(blocked)).has(repositoryId)) {
          return yield* new CiRepairProcessStillRunningError({
            repositoryId,
            message:
              "The previous CI repair process is still running. It must stop before another repair can start.",
          })
        }
        const repository = yield* requireRepository(repositoryId)
        if (repository.forge !== "github") {
          return yield* new CiRepairNotSupportedError({
            repositoryId,
            message:
              "CI repair execution is supported for GitHub repositories only. Gate observation for this forge is unchanged.",
          })
        }
        const gate = yield* pictureGate(repository)
        if (gate.status !== "closed" || gate.incidentId === null) {
          return yield* new CiRepairNotEligibleError({
            repositoryId,
            message:
              gate.status === "degraded"
                ? "CI repair starts only for a current Closed incident. Degraded observation is not a Closed gate."
                : "CI repair starts only while a current Closed incident is active.",
          })
        }
        // Readiness is checked before admission so a missing backend does not
        // consume the incident's automatic attempt.
        yield* resolveLaunch(repository)
        const admitted = yield* admit({
          repositoryId,
          incidentId: gate.incidentId,
          requestSource: "manual",
        })
        if (admitted._tag === "ineligible") {
          return yield* new CiRepairNotEligibleError({
            repositoryId,
            message: "CI repair could not be admitted for this incident.",
          })
        }
        if (admitted._tag === "blocked") {
          const raced = yield* activeRow(repositoryId)
          if (raced === null) {
            return yield* new CiRepairNotEligibleError({
              repositoryId,
              message: "Another CI repair is already queued or running.",
            })
          }
          return yield* toView(raced)
        }
        if (admitted._tag === "created" && autoDrive) {
          yield* forkDrive(admitted.row.id)
        }
        return yield* toView(admitted.row)
      })

    // Callers such as Repository refresh do not carry the repair context.
    // The services were captured when this supervisor was built.
    const provideCallContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(DbService, db),
        Effect.provideService(WorkItemLifecycle, lifecycle),
        Effect.provideService(GitHubService, github),
        Effect.provideService(GitLabService, gitlab),
        Effect.provideService(AzureDevOpsService, azure),
        Effect.provideService(KeymaxxerService, keymaxxer),
        Effect.provideService(ActiveAgentBackend, active),
      )

    const considerAutomatic = (repositoryId: string) =>
      provideCallContext(
        Effect.gen(function* () {
          const repository = (yield* db.listRepositories).find(
            (candidate) => candidate.id === repositoryId,
          )
          if (
            repository === undefined ||
            repository.forge !== "github" ||
            repository.paused ||
            !repository.automaticCiRepair
          ) {
            return null
          }
          const definitions = yield* db.listCiGateDefinitions(repository.id)
          const snapshot = yield* db.loadCiGateSnapshot(repository.id)
          const status = deriveRepositoryCiGateStatus({
            selectedCount: definitions.length,
            observations: snapshot.observations,
          })
          const incidentId = snapshot.activeIncident?.id ?? null
          if (status !== "closed" || incidentId === null) {
            return null
          }
          const ready = yield* resolveLaunch(repository).pipe(Effect.result)
          if (Result.isFailure(ready)) {
            return null
          }
          const admitted = yield* admit({
            repositoryId,
            incidentId,
            requestSource: "automatic",
          })
          if (admitted._tag === "blocked" || admitted._tag === "ineligible") {
            return null
          }
          if (admitted._tag === "created" && autoDrive) {
            yield* forkDrive(admitted.row.id)
          }
          return yield* toView(admitted.row)
        }),
      )

    return {
      startManual,
      drive,
      latestForRepository,
      considerAutomatic,
      reconcile,
    } satisfies RepositoryCiRepairShape
  })

export const RepositoryCiRepairLive = (options?: {
  readonly autoDrive?: boolean
  readonly pollInterval?: Duration.Duration
}) =>
  Layer.effect(
    RepositoryCiRepair,
    Effect.gen(function* () {
      const repair = yield* makeRepositoryCiRepair(options)
      yield* repair.reconcile()
      return repair
    }),
  )
