import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  Config,
  Duration,
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
} from "effect"
import {
  type MergePullRequestResult,
  type PrStatusCheckDiagnostic,
  type PullRequestCheckStatus,
  type PullRequestLifecycleStatus,
  type PullRequestMergeability,
  type TerminalPrStatusCheck,
  extractErrorCode,
} from "@ready-for-agent/github-service"
import { GitLabProjectUnavailableError, GitLabRequestError } from "./errors.js"
import {
  GitLabService,
  type GitLabServiceError,
  type GitLabServiceShape,
} from "./gitlab-service.js"
import type { GitLabReadyLabeledIssue, GitLabRepository } from "./types.js"

const REQUEST_TIMEOUT = Duration.seconds(30)
const READY_LABEL = "ready-for-agent"
const PAGE_SIZE = 100
/** Tail of a job trace kept for Investigate (matches GitHub Actions default). */
const DEFAULT_MAX_EXCERPT_CHARS = 12_000

type GitLabFetch = typeof fetch

class GitLabHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)
const ProjectSchema = Schema.Struct({
  id: Schema.optional(PositiveInt),
  path_with_namespace: RequiredString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  /** Canonical web/API host lives here; SSH remotes may use a different host. */
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
})

/**
 * Normalize a Forge Host string (hostname or hostname:port).
 * Keeps non-default ports so self-hosted instances on :8443 stay reachable.
 */
export const normalizeGitLabForgeHost = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed === "") return trimmed
  const withPort = /^(.+):(\d+)$/.exec(trimmed)
  if (withPort?.[1] !== undefined && withPort[2] !== undefined) {
    const hostname = withPort[1].toLowerCase().replace(/^www\./, "")
    return hostname.length > 0 ? `${hostname}:${withPort[2]}` : trimmed
  }
  return trimmed.toLowerCase().replace(/^www\./, "")
}

/**
 * Prefer the host from project web_url over the clone/SSH remote host.
 * Drupal's GitLab serves SSH as git.drupal.org and HTTPS/API as git.drupalcode.org.
 * Uses hostname + non-default port (URL.host semantics) so custom-port instances
 * are not rewritten to portless hosts.
 */
const forgeHostFromProjectWebUrl = (
  webUrl: string | null | undefined,
  fallbackHost: string,
): string => {
  if (webUrl === null || webUrl === undefined || webUrl.trim() === "") {
    return normalizeGitLabForgeHost(fallbackHost)
  }
  try {
    const url = new URL(webUrl)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "")
    if (hostname.length === 0) return normalizeGitLabForgeHost(fallbackHost)
    // url.port is empty for default scheme ports; keep only explicit ports.
    return url.port === "" ? hostname : `${hostname}:${url.port}`
  } catch {
    return normalizeGitLabForgeHost(fallbackHost)
  }
}

const resolvedRepositoryIdentity = (
  repository: GitLabRepository,
  project: {
    readonly path_with_namespace: string
    readonly web_url?: string | null
  },
): GitLabRepository => ({
  forge: repository.forge,
  forgeHost: forgeHostFromProjectWebUrl(project.web_url, repository.forgeHost),
  projectPath: project.path_with_namespace,
})
const UserSchema = Schema.Struct({
  username: RequiredString,
})
const IssueSchema = Schema.Struct({
  iid: PositiveInt,
  title: RequiredString,
  description: Schema.NullOr(Schema.String),
  web_url: RequiredString,
  created_at: RequiredString,
  state: Schema.Literal("opened"),
  author: Schema.NullOr(
    Schema.Struct({
      username: RequiredString,
    }),
  ),
})
const IssueStateSchema = Schema.Struct({
  iid: PositiveInt,
  state: Schema.Literals(["opened", "closed"]),
})
const NoteSchema = Schema.Struct({
  body: Schema.NullOr(Schema.String),
})
const MergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  state: Schema.Literals(["opened", "merged", "closed"]),
  draft: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
  source_branch: Schema.optional(Schema.NullOr(Schema.String)),
  source_project_id: Schema.optional(Schema.NullOr(PositiveInt)),
})
const OpenMergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  draft: Schema.Boolean,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
})
const CreatedMergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  draft: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.NullOr(Schema.String)),
})
const HeadPipelineSchema = Schema.Struct({
  id: PositiveInt,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * GitLab pipeline ref. Merged-results pipelines use
   * `refs/merge-requests/<iid>/merge` (SHA is never the source tip). Detached
   * MR head pipelines use `…/head` (SHA is the source tip). Branch pipelines
   * use the branch name. Only the merged-results form skips tip-SHA equality.
   */
  ref: Schema.optional(Schema.NullOr(Schema.String)),
  /** GitLab pipeline source (`push`, `merge_request_event`, …); decoded for fidelity. */
  source: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
})
const MergeRequestCheckSchema = Schema.Struct({
  iid: PositiveInt,
  // locked: short-lived while GitLab is performing a merge.
  state: Schema.Literals(["opened", "merged", "closed", "locked"]),
  draft: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  target_branch: Schema.optional(Schema.NullOr(Schema.String)),
  detailed_merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  /** True only for actual base/source git conflicts when GitLab provides it. */
  has_conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  head_pipeline: Schema.optional(Schema.NullOr(HeadPipelineSchema)),
})
type MergeRequestCheck = typeof MergeRequestCheckSchema.Type
const PipelineJobSchema = Schema.Struct({
  id: PositiveInt,
  name: RequiredString,
  status: RequiredString,
  allow_failure: Schema.optional(Schema.Boolean),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
})
const CommitMetaSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  committed_date: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
})

type GitLabIssue = typeof IssueSchema.Type
type GitLabMergeRequest = typeof MergeRequestSchema.Type
type OpenMergeRequest = typeof OpenMergeRequestSchema.Type
type PipelineJob = typeof PipelineJobSchema.Type

const emptyTerminalChecks: readonly TerminalPrStatusCheck[] = []

const emptyCheckSnapshotFields = {
  mergeability: "unknown" as const,
  baseRefName: null,
  headPushedAt: null,
  headSha: null,
  createdAt: null,
  isDraft: null,
}

const parseInstant = (value: string | null | undefined): Date | null => {
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Map GitLab merge status to Watch mergeability.
 *
 * Watch treats `conflicting` as a Merge Conflict Handoff (rebase), so only
 * true git conflicts must map there. Policy/CI/review/UI blockers (and
 * closed/merged `not_open`) often still report `merge_status: cannot_be_merged`
 * and must not invent a conflict.
 */
const mapMergeability = (mergeRequest: {
  readonly detailed_merge_status?: string | null
  readonly merge_status?: string | null
  readonly has_conflicts?: boolean | null
}): PullRequestMergeability => {
  if (mergeRequest.has_conflicts === true) return "conflicting"
  const detailed = (mergeRequest.detailed_merge_status ?? "").toLowerCase()
  const merge = (mergeRequest.merge_status ?? "").toLowerCase()
  if (detailed === "conflict") return "conflicting"
  if (
    detailed === "checking" ||
    detailed === "unchecked" ||
    detailed === "preparing" ||
    detailed === "commits_status" ||
    merge === "checking" ||
    merge === "unchecked"
  ) {
    return "unknown"
  }
  if (merge === "can_be_merged" || detailed === "mergeable") {
    return "mergeable"
  }
  // Any other non-empty detailed status (policy, approvals, CI, not_open, …)
  // is not a rebase-required merge conflict for Watch.
  if (detailed !== "") return "mergeable"
  if (mergeRequest.has_conflicts === false) return "mergeable"
  // Legacy coarse API without detailed_merge_status / has_conflicts.
  if (merge === "cannot_be_merged") return "conflicting"
  return "unknown"
}

/**
 * Classify one head-pipeline job for Watch.
 * - success → green
 * - failed without allow_failure → red
 * - failed with allow_failure, manual, canceled, skipped → ignore (no handoff)
 * - pending/running and peers → pending (not terminal)
 */
const classifyPipelineJob = (
  job: PipelineJob,
): "green" | "red" | "pending" | "ignore" => {
  const status = job.status.trim().toLowerCase()
  if (status === "success") return "green"
  if (status === "failed" || status === "failure") {
    return job.allow_failure === true ? "ignore" : "red"
  }
  if (
    status === "manual" ||
    status === "canceled" ||
    status === "cancelled" ||
    status === "skipped"
  ) {
    return "ignore"
  }
  if (
    status === "created" ||
    status === "pending" ||
    status === "running" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  ) {
    return "pending"
  }
  // Unknown statuses stay pending so Watch does not advance early.
  return "pending"
}

const toTerminalChecks = (
  jobs: readonly PipelineJob[],
): readonly TerminalPrStatusCheck[] => {
  const terminals: TerminalPrStatusCheck[] = []
  for (const job of jobs) {
    const kind = classifyPipelineJob(job)
    if (kind === "green" || kind === "red") {
      terminals.push({
        externalId: `gitlab-job:${job.id}`,
        name: job.name,
        outcome: kind,
      })
    }
  }
  return terminals.sort((left, right) =>
    left.externalId.localeCompare(right.externalId),
  )
}

const aggregatePipelineStatus = (
  jobs: readonly PipelineJob[],
): "pending" | "succeeded" | "failed" | "no_checks" => {
  let hasGreen = false
  let hasRed = false
  let hasPending = false
  for (const job of jobs) {
    const kind = classifyPipelineJob(job)
    if (kind === "pending") hasPending = true
    else if (kind === "green") hasGreen = true
    else if (kind === "red") hasRed = true
  }
  if (hasPending) return "pending"
  if (hasRed) return "failed"
  if (hasGreen) return "succeeded"
  return "no_checks"
}

/**
 * When the combined jobs+bridges list is empty, derive Watch rollup from the
 * head pipeline's own status so a still-starting or failed empty pipeline is
 * not treated as settled `no_checks`.
 *
 * Pipeline-level `manual` aligns with job-level manual: never blocks rollup
 * (ADR 0043). Only use this helper when zero jobs were observed — if jobs
 * exist but are all ignore, job aggregate `no_checks` already settles.
 */
const aggregateEmptyJobsFromPipelineStatus = (
  pipelineStatus: string | null | undefined,
): "pending" | "succeeded" | "failed" | "no_checks" => {
  const status = (pipelineStatus ?? "").trim().toLowerCase()
  if (
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "waiting_for_callback" ||
    status === "pending" ||
    status === "running" ||
    status === "scheduled" ||
    status === "canceling" ||
    status === "cancelling"
  ) {
    return "pending"
  }
  if (status === "failed" || status === "canceled" || status === "cancelled") {
    return "failed"
  }
  if (status === "success") {
    return "succeeded"
  }
  // manual / skipped: no automated work remains — settled non-failing.
  if (status === "manual" || status === "skipped") {
    return "no_checks"
  }
  // Unknown or omitted pipeline status with no jobs: keep polling.
  return "pending"
}

const mergePipelineJobs = (
  jobs: readonly PipelineJob[],
  bridges: readonly PipelineJob[],
): readonly PipelineJob[] => {
  const byId = new Map<number, PipelineJob>()
  for (const job of jobs) byId.set(job.id, job)
  for (const bridge of bridges) byId.set(bridge.id, bridge)
  return [...byId.values()].sort((left, right) => left.id - right.id)
}

const stripDraftTitlePrefix = (title: string): string => {
  let stripped = title.trim()
  // Nested "Draft: Draft: …" / "WIP: Draft: …" can remain after one strip and
  // still look draft to isDraftMergeRequest after mark-ready.
  while (DRAFT_TITLE_PREFIX.test(stripped)) {
    stripped = stripped.replace(DRAFT_TITLE_PREFIX, "").trim()
  }
  // Empty remainder (e.g. "Draft:" alone) must not keep the draft prefix or
  // mark-ready verification will still treat the title as draft.
  return stripped === "" ? "Ready" : stripped
}

const boundLogExcerpt = (logText: string, maxExcerptChars: number): string => {
  if (logText.length <= maxExcerptChars) return logText
  return logText.slice(logText.length - maxExcerptChars)
}

const safeLogFileName = (externalId: string): string =>
  `${externalId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.log`

const parseGitlabJobId = (externalId: string): number | null => {
  if (!externalId.startsWith("gitlab-job:")) return null
  const raw = externalId.slice("gitlab-job:".length)
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** Hidden HTML comment marker tying a completion summary to a Work Item. */
const workItemCompletionMarker = (workItemId: string): string =>
  `<!-- ready-for-agent:work-item:${workItemId} -->`

/**
 * GitLab draft status is title-driven on many instances (Draft:/WIP: prefixes).
 * The REST `draft` boolean is not universally accepted on create, so Create PR
 * and draft-copy reconcile always preserve a draft title form for open drafts.
 */
const DRAFT_TITLE_PREFIX = /^\s*(?:Draft|WIP)\s*:\s*/i

const hasDraftTitlePrefix = (title: string): boolean =>
  DRAFT_TITLE_PREFIX.test(title)

const withDraftTitlePrefix = (title: string): string => {
  const trimmed = title.trim()
  if (trimmed === "") return "Draft:"
  if (hasDraftTitlePrefix(trimmed)) return trimmed
  return `Draft: ${trimmed}`
}

const isDraftMergeRequest = (mergeRequest: {
  readonly draft?: boolean
  readonly title?: string | null
}): boolean =>
  mergeRequest.draft === true || hasDraftTitlePrefix(mergeRequest.title ?? "")

/**
 * Merged-results pipelines run on `refs/merge-requests/<iid>/merge`; their
 * pipeline SHA is the temporary merge commit, never the source-branch tip.
 * Tip-aligned MR pipelines (`…/head`, branch ref, or source-only
 * `merge_request_event`) still use SHA equality for stale-after-push detection.
 */
const MERGED_RESULTS_PIPELINE_REF = /^refs\/merge-requests\/\d+\/merge$/

/**
 * True when head_pipeline is a merged-results pipeline. Only this shape is
 * exempt from tip-SHA equality while GitLab still attaches it as head_pipeline.
 */
const isMergedResultsHeadPipeline = (headPipeline: {
  readonly ref?: string | null
}): boolean => {
  const ref =
    typeof headPipeline.ref === "string" ? headPipeline.ref.trim() : ""
  return ref !== "" && MERGED_RESULTS_PIPELINE_REF.test(ref)
}

/**
 * True when the attached head_pipeline is for a prior tip and must not settle
 * green (Watch) or pass merge pre-checks.
 *
 * Branch and tip-aligned MR pipelines: treat a known SHA mismatch with the MR
 * tip as stale (left behind after a push until GitLab replaces head_pipeline).
 *
 * Merged-results pipelines (`refs/merge-requests/<iid>/merge`): the pipeline
 * SHA is the temporary merge commit, not the source tip — never stale solely
 * because of that mismatch while GitLab still exposes them as head_pipeline.
 */
const isStaleHeadPipelineForTip = (mergeRequest: {
  readonly sha?: string | null
  readonly head_pipeline?: {
    readonly sha?: string | null
    readonly ref?: string | null
    readonly source?: string | null
  } | null
}): boolean => {
  const headPipeline = mergeRequest.head_pipeline
  if (headPipeline === null || headPipeline === undefined) return false
  if (isMergedResultsHeadPipeline(headPipeline)) return false
  const mrHead =
    typeof mergeRequest.sha === "string" && mergeRequest.sha.trim() !== ""
      ? mergeRequest.sha.trim()
      : null
  const pipelineSha =
    typeof headPipeline.sha === "string" && headPipeline.sha.trim() !== ""
      ? headPipeline.sha.trim()
      : null
  return mrHead !== null && pipelineSha !== null && pipelineSha !== mrHead
}

const apiBase = (repository: GitLabRepository): string =>
  `https://${repository.forgeHost}/api/v4`

const projectApiPath = (repository: GitLabRepository): string =>
  `/projects/${encodeURIComponent(repository.projectPath)}`

const requestError = (message: string, cause: unknown): GitLabRequestError => {
  const code = extractErrorCode(cause)
  return new GitLabRequestError({
    message,
    cause,
    ...(code !== undefined ? { code } : {}),
    ...(cause instanceof GitLabHttpError
      ? { statusCode: cause.statusCode }
      : {}),
  })
}

const decode = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

/**
 * Decode unknown API JSON into a typed Fail channel error (never a fiber defect).
 * Sync throws from Schema.decodeUnknownSync become GitLabRequestError via Effect.try.
 */
const decodeEffect = <A>(
  schema: { readonly Type: A } & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
  message: string,
): Effect.Effect<A, GitLabRequestError> =>
  Effect.try({
    try: () => decode(schema, value) as A,
    catch: (cause) => requestError(message, cause),
  })

/** Decode an MR check payload into a typed request error (never a defect). */
const decodeMergeRequestCheck = (
  value: unknown,
  message: string,
): Effect.Effect<MergeRequestCheck, GitLabRequestError> =>
  decodeEffect(MergeRequestCheckSchema, value, message)

const closingIssueNumbers = (description: string): ReadonlySet<number> => {
  const numbers = new Set<number>()
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi
  for (const match of description.matchAll(pattern)) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number)) numbers.add(number)
  }
  return numbers
}

const blockerNumbers = (body: string): readonly number[] => {
  const numbers = new Set<number>()
  for (const line of body.matchAll(/^\s*Blocked by:\s*(.+)$/gim)) {
    for (const reference of (line[1] ?? "").matchAll(/#([1-9]\d*)\b/g)) {
      const number = Number(reference[1])
      if (Number.isSafeInteger(number)) numbers.add(number)
    }
  }
  return [...numbers]
}

const mergeRequestState = (
  state: GitLabMergeRequest["state"],
): "OPEN" | "MERGED" | "CLOSED" =>
  state === "opened" ? "OPEN" : state === "merged" ? "MERGED" : "CLOSED"

const sourceRepositoryIdentity = (
  repository: GitLabRepository,
  mergeRequest: GitLabMergeRequest,
  projectId: number | undefined,
): string | null => {
  if (mergeRequest.source_project_id == null) {
    return null
  }
  if (projectId !== undefined && mergeRequest.source_project_id === projectId) {
    return repository.projectPath
  }
  return `gitlab-project:${mergeRequest.source_project_id}`
}

const mapIssue = (
  repository: GitLabRepository,
  issue: GitLabIssue,
  mergeRequests: readonly GitLabMergeRequest[],
  projectId: number | undefined,
): GitLabReadyLabeledIssue => {
  const body = issue.description ?? ""
  const createdAt = new Date(issue.created_at)
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Invalid GitLab Issue creation time: ${issue.created_at}`)
  }
  return {
    number: issue.iid,
    title: issue.title,
    body,
    url: issue.web_url,
    createdAt,
    state: "OPEN",
    author: issue.author?.username ?? null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    hierarchySupported: false,
    blockedBy: blockerNumbers(body).map((number) => ({
      number,
      url: `https://${repository.forgeHost}/${repository.projectPath}/-/issues/${number}`,
    })),
    closingPullRequests: mergeRequests
      .filter((mergeRequest) =>
        closingIssueNumbers(mergeRequest.description ?? "").has(issue.iid),
      )
      .map((mergeRequest) => {
        const sourceBranch = mergeRequest.source_branch?.trim() ?? ""
        return {
          number: mergeRequest.iid,
          repository: repository.projectPath,
          state: mergeRequestState(mergeRequest.state),
          isDraft: mergeRequest.draft,
          sourceBranch: sourceBranch === "" ? null : sourceBranch,
          sourceRepository: sourceRepositoryIdentity(
            repository,
            mergeRequest,
            projectId,
          ),
        }
      }),
  }
}

type RequestInitOptions = {
  readonly method?: string
  readonly body?: unknown
  readonly acceptEmpty?: boolean
}

export const makeGitLabService = (options: {
  readonly token?: string
  readonly fetch?: GitLabFetch
}): GitLabServiceShape => {
  const fetchImpl = options.fetch ?? fetch
  const headers: Record<string, string> =
    options.token === undefined || options.token.trim() === ""
      ? { Accept: "application/json" }
      : {
          Accept: "application/json",
          "PRIVATE-TOKEN": options.token,
        }

  const requestUnknown = (
    repository: GitLabRepository,
    path: string,
    message: string,
    init: RequestInitOptions = {},
  ): Effect.Effect<unknown, GitLabRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const method = init.method ?? "GET"
        const response = await fetchImpl(`${apiBase(repository)}${path}`, {
          method,
          headers: {
            ...headers,
            ...(init.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        })
        if (!response.ok) {
          throw new GitLabHttpError(
            response.status,
            `${message}: GitLab returned HTTP ${response.status}`,
          )
        }
        if (init.acceptEmpty === true || response.status === 204) {
          const text = await response.text()
          if (text.trim() === "") return null
          try {
            return JSON.parse(text) as unknown
          } catch {
            return null
          }
        }
        return await response.json()
      },
      catch: (cause) => requestError(message, cause),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(requestError(`${message} timed out`, cause)),
      ),
    )

  /** Plain-text response body (pipeline job traces). */
  const requestText = (
    repository: GitLabRepository,
    path: string,
    message: string,
  ): Effect.Effect<string, GitLabRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${apiBase(repository)}${path}`, {
          method: "GET",
          headers,
        })
        if (!response.ok) {
          throw new GitLabHttpError(
            response.status,
            `${message}: GitLab returned HTTP ${response.status}`,
          )
        }
        return await response.text()
      },
      catch: (cause) => requestError(message, cause),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(requestError(`${message} timed out`, cause)),
      ),
    )

  const requestPages = (
    repository: GitLabRepository,
    path: string,
    message: string,
  ): Effect.Effect<readonly unknown[], GitLabRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const values: unknown[] = []
        let page = 1
        while (true) {
          const separator = path.includes("?") ? "&" : "?"
          const response = await fetchImpl(
            `${apiBase(repository)}${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
            { headers },
          )
          if (!response.ok) {
            throw new GitLabHttpError(
              response.status,
              `${message}: GitLab returned HTTP ${response.status}`,
            )
          }
          const decoded: unknown = await response.json()
          if (!Array.isArray(decoded)) {
            throw new Error(`${message}: GitLab returned a non-array page`)
          }
          values.push(...decoded)
          const nextPage = response.headers.get("x-next-page")?.trim() ?? ""
          if (nextPage === "") break
          const parsed = Number(nextPage)
          if (!Number.isSafeInteger(parsed) || parsed <= page) {
            throw new Error(`${message}: invalid GitLab x-next-page header`)
          }
          page = parsed
        }
        return values
      },
      catch: (cause) => requestError(message, cause),
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(requestError(`${message} timed out`, cause)),
      ),
    )

  const unavailableOn404 = <A>(
    repository: GitLabRepository,
    effect: Effect.Effect<A, GitLabRequestError>,
  ): Effect.Effect<A, GitLabProjectUnavailableError | GitLabRequestError> =>
    effect.pipe(
      Effect.catch(
        (
          error,
        ): Effect.Effect<
          never,
          GitLabProjectUnavailableError | GitLabRequestError
        > =>
          error.statusCode === 404
            ? Effect.fail(new GitLabProjectUnavailableError(repository))
            : Effect.fail(error),
      ),
    )

  const listMergeRequestsForBranch = (
    repository: GitLabRepository,
    headRefName: string,
    state: "opened" | "all",
  ): Effect.Effect<readonly OpenMergeRequest[], GitLabRequestError> =>
    requestPages(
      repository,
      `${projectApiPath(repository)}/merge_requests?state=${state}&source_branch=${encodeURIComponent(headRefName)}&order_by=updated_at&sort=desc`,
      `Failed to list merge requests for ${repository.projectPath}:${headRefName}`,
    ).pipe(
      Effect.flatMap((values) =>
        decodeEffect(
          Schema.Array(OpenMergeRequestSchema),
          values,
          `GitLab returned invalid merge request data for ${repository.projectPath}:${headRefName}`,
        ),
      ),
    )

  const listOpenMergeRequestsForBranch = (
    repository: GitLabRepository,
    headRefName: string,
  ): Effect.Effect<readonly OpenMergeRequest[], GitLabRequestError> =>
    listMergeRequestsForBranch(repository, headRefName, "opened")

  /**
   * Prefer an open MR for the branch; if none, the latest any-state MR
   * (closed/merged) so Watch can observe terminal lifecycle outcomes.
   */
  const resolveMergeRequestIidForBranch = (
    repository: GitLabRepository,
    headRefName: string,
  ): Effect.Effect<number | null, GitLabServiceError> =>
    unavailableOn404(
      repository,
      Effect.gen(function* () {
        const open = yield* listOpenMergeRequestsForBranch(
          repository,
          headRefName,
        )
        const openFirst = open[0]
        if (openFirst !== undefined) return openFirst.iid
        const anyState = yield* listMergeRequestsForBranch(
          repository,
          headRefName,
          "all",
        )
        const latest = anyState[0]
        return latest === undefined ? null : latest.iid
      }),
    )

  const findOpenMergeRequestNumberImpl = (
    repository: GitLabRepository,
    headRefName: string,
  ): Effect.Effect<number | null, GitLabServiceError> =>
    unavailableOn404(
      repository,
      listOpenMergeRequestsForBranch(repository, headRefName).pipe(
        Effect.map((mergeRequests) => {
          const first = mergeRequests[0]
          return first === undefined ? null : first.iid
        }),
      ),
    )

  return {
    verifyProject: Effect.fn("GitLabService.verifyProject")((repository) =>
      unavailableOn404(
        repository,
        requestUnknown(
          repository,
          projectApiPath(repository),
          `Failed to verify GitLab project ${repository.projectPath} on ${repository.forgeHost}`,
        ).pipe(
          Effect.map((value) => {
            const project = decode(ProjectSchema, value)
            return resolvedRepositoryIdentity(repository, project)
          }),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError("GitLab returned an invalid project", error),
          ),
        ),
      ),
    ),
    getAuthenticatedUserLogin: Effect.fn(
      "GitLabService.getAuthenticatedUserLogin",
    )((repository) =>
      unavailableOn404(
        repository,
        requestUnknown(
          repository,
          "/user",
          `Failed to resolve authenticated GitLab user on ${repository.forgeHost}`,
        ).pipe(
          Effect.map((value) => decode(UserSchema, value).username),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError("GitLab returned an invalid user", error),
          ),
        ),
      ),
    ),
    listReadyIssues: Effect.fn("GitLabService.listReadyIssues")(
      (repository) => {
        const project = projectApiPath(repository)
        return unavailableOn404(
          repository,
          Effect.all(
            [
              requestPages(
                repository,
                `${project}/issues?state=opened&labels=${encodeURIComponent(READY_LABEL)}`,
                `Failed to list Ready Issues for ${repository.projectPath}`,
              ),
              requestPages(
                repository,
                `${project}/merge_requests?scope=all&state=all`,
                `Failed to list merge requests for ${repository.projectPath}`,
              ),
              requestUnknown(
                repository,
                project,
                `Failed to resolve GitLab project metadata for ${repository.projectPath}`,
              ),
            ],
            { concurrency: 3 },
          ).pipe(
            Effect.map(([issues, mergeRequests, projectMeta]) => {
              const decodedIssues = decode(Schema.Array(IssueSchema), issues)
              const decodedMergeRequests = decode(
                Schema.Array(MergeRequestSchema),
                mergeRequests,
              )
              const projectId = decode(ProjectSchema, projectMeta).id
              return decodedIssues
                .map((issue) =>
                  mapIssue(repository, issue, decodedMergeRequests, projectId),
                )
                .sort((left, right) => left.number - right.number)
            }),
            Effect.mapError((error) =>
              error instanceof GitLabRequestError
                ? error
                : requestError("GitLab returned invalid issue data", error),
            ),
          ),
        )
      },
    ),
    hasCredentials: () => Effect.succeed(options.token !== undefined),
    hasAmbientCredentials: () => Effect.succeed(options.token !== undefined),
    getOpenPullRequestNumber: Effect.fn(
      "GitLabService.getOpenPullRequestNumber",
    )(function* (repository, headRefName) {
      const number = yield* findOpenMergeRequestNumberImpl(
        repository,
        headRefName,
      )
      if (number === null) {
        return yield* new GitLabRequestError({
          message: `No open merge request found for ${repository.projectPath}:${headRefName}`,
        })
      }
      return number
    }),
    findOpenPullRequestNumber: Effect.fn(
      "GitLabService.findOpenPullRequestNumber",
    )((repository, headRefName) =>
      findOpenMergeRequestNumberImpl(repository, headRefName),
    ),
    createDraftPullRequest: Effect.fn("GitLabService.createDraftPullRequest")(
      function* (repository, input) {
        const project = projectApiPath(repository)
        const projectMeta = yield* unavailableOn404(
          repository,
          requestUnknown(
            repository,
            project,
            `Failed to resolve GitLab project metadata for ${repository.projectPath}`,
          ).pipe(
            Effect.map((value) => decode(ProjectSchema, value)),
            Effect.mapError((error) =>
              error instanceof GitLabRequestError
                ? error
                : requestError(
                    `GitLab returned invalid project metadata for ${repository.projectPath}`,
                    error,
                  ),
            ),
          ),
        )
        const defaultBase = projectMeta.default_branch?.trim() ?? ""
        const baseRefName =
          input.baseRefName !== undefined && input.baseRefName.trim() !== ""
            ? input.baseRefName.trim()
            : defaultBase
        if (baseRefName === "") {
          return yield* new GitLabRequestError({
            message: `Repository ${repository.projectPath} has no default base branch`,
          })
        }
        const draftTitle = withDraftTitlePrefix(input.title)
        const created = yield* unavailableOn404(
          repository,
          requestUnknown(
            repository,
            `${project}/merge_requests`,
            `Failed to create draft merge request for ${repository.projectPath}:${input.headRefName}`,
            {
              method: "POST",
              body: {
                source_branch: input.headRefName,
                target_branch: baseRefName,
                // Title prefix is the portable draft signal; keep `draft: true`
                // for instances that accept it (GitLab 14.2+).
                title: draftTitle,
                description: input.body,
                draft: true,
              },
            },
          ).pipe(
            Effect.map((value) => decode(CreatedMergeRequestSchema, value)),
            Effect.mapError((error) =>
              error instanceof GitLabRequestError
                ? error
                : requestError(
                    `GitLab returned an invalid merge request after create for ${repository.projectPath}:${input.headRefName}`,
                    error,
                  ),
            ),
          ),
        )
        if (!isDraftMergeRequest(created)) {
          return yield* new GitLabRequestError({
            message: `GitLab did not create a draft merge request for ${repository.projectPath}:${input.headRefName}`,
          })
        }
        return created.iid
      },
    ),
    updateOpenDraftPullRequestCopy: Effect.fn(
      "GitLabService.updateOpenDraftPullRequestCopy",
    )(function* (repository, headRefName, input) {
      const open = yield* unavailableOn404(
        repository,
        listOpenMergeRequestsForBranch(repository, headRefName),
      )
      const details = open[0]
      if (details === undefined) {
        return null
      }
      // Non-draft open MRs (ready for review / human-edited): do not overwrite.
      if (!isDraftMergeRequest(details)) {
        return details.iid
      }
      // Preserve draft title form so reconcile never undrafts via prefix removal.
      const desiredTitle = withDraftTitlePrefix(input.title)
      const currentTitle = details.title ?? ""
      const currentBody = details.description ?? ""
      if (currentTitle === desiredTitle && currentBody === input.body) {
        return details.iid
      }
      // Copy update is best-effort: open draft identity remains valid.
      yield* requestUnknown(
        repository,
        `${projectApiPath(repository)}/merge_requests/${details.iid}`,
        `Failed to update draft merge request !${details.iid} for ${repository.projectPath}`,
        {
          method: "PUT",
          body: {
            title: desiredTitle,
            description: input.body,
          },
        },
      ).pipe(Effect.asVoid, Effect.ignore)
      return details.iid
    }),
    countOpenNonDraftPullRequests: Effect.fn(
      "GitLabService.countOpenNonDraftPullRequests",
    )((repository) =>
      unavailableOn404(
        repository,
        requestPages(
          repository,
          `${projectApiPath(repository)}/merge_requests?state=opened&wip=no`,
          `Failed to count open non-draft merge requests for ${repository.projectPath}`,
        ).pipe(
          Effect.map((values) => {
            const decoded = decode(Schema.Array(OpenMergeRequestSchema), values)
            // Match create/reconcile: title-prefixed drafts count as drafts even
            // when the boolean is missing or wip=no returns an inconsistent row.
            return decoded.filter(
              (mergeRequest) => !isDraftMergeRequest(mergeRequest),
            ).length
          }),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError(
                  `GitLab returned invalid merge request count data for ${repository.projectPath}`,
                  error,
                ),
          ),
        ),
      ),
    ),
    getPullRequestCheckStatus: Effect.fn(
      "GitLabService.getPullRequestCheckStatus",
    )(function* (repository, headRefName) {
      const mergeRequestIid = yield* resolveMergeRequestIidForBranch(
        repository,
        headRefName,
      )
      // Not-yet-visible MR after Create PR: same pending empty snapshot as GitHub.
      if (mergeRequestIid === null) {
        return {
          _tag: "pending",
          terminalChecks: emptyTerminalChecks,
          ...emptyCheckSnapshotFields,
        } satisfies PullRequestCheckStatus
      }

      const project = projectApiPath(repository)
      // Do not map single-MR 404 to project-unavailable: the project was already
      // listed. A raced/deleted MR is "not yet / no longer visible" for Watch.
      const mergeRequestLoad = yield* requestUnknown(
        repository,
        `${project}/merge_requests/${mergeRequestIid}`,
        `Failed to load merge request !${mergeRequestIid} for ${repository.projectPath}`,
      ).pipe(
        Effect.flatMap((value) =>
          decodeMergeRequestCheck(
            value,
            `GitLab returned an invalid merge request for ${repository.projectPath}:${headRefName}`,
          ),
        ),
        Effect.result,
      )
      if (Result.isFailure(mergeRequestLoad)) {
        if (
          mergeRequestLoad.failure instanceof GitLabRequestError &&
          mergeRequestLoad.failure.statusCode === 404
        ) {
          return {
            _tag: "pending",
            terminalChecks: emptyTerminalChecks,
            ...emptyCheckSnapshotFields,
          } satisfies PullRequestCheckStatus
        }
        return yield* mergeRequestLoad.failure
      }
      const mergeRequest = mergeRequestLoad.success

      const headSha =
        typeof mergeRequest.sha === "string" && mergeRequest.sha.trim() !== ""
          ? mergeRequest.sha
          : null
      const baseRefName =
        typeof mergeRequest.target_branch === "string" &&
        mergeRequest.target_branch.trim() !== ""
          ? mergeRequest.target_branch
          : null
      const createdAt = parseInstant(mergeRequest.created_at)
      const isDraft = isDraftMergeRequest(mergeRequest)
      const mergeability = mapMergeability(mergeRequest)

      // Commit push time is best-effort; any lookup failure leaves null so
      // Check-Start Deadline can use the observation fallback.
      let headPushedAt: Date | null = null
      if (headSha !== null) {
        const commitResult = yield* requestUnknown(
          repository,
          `${project}/repository/commits/${encodeURIComponent(headSha)}`,
          `Failed to load head commit ${headSha} for ${repository.projectPath}`,
        ).pipe(Effect.result)
        if (Result.isSuccess(commitResult)) {
          const commit = yield* Effect.try({
            try: () => decode(CommitMetaSchema, commitResult.success),
            catch: () => null as null,
          }).pipe(Effect.orElseSucceed(() => null))
          if (commit !== null) {
            headPushedAt =
              parseInstant(commit.committed_date) ??
              parseInstant(commit.created_at)
          }
        }
      }

      const snapshot = {
        mergeability,
        baseRefName,
        headPushedAt,
        headSha,
        createdAt,
        isDraft,
      } as const

      if (mergeRequest.state === "merged") {
        // Watch prioritizes mergeability over _tag; merged MRs often report
        // not_open + cannot_be_merged. Force non-blocking mergeability so
        // lifecycle can take the succeeded path (cleanup) instead of conflict
        // handoff or perpetual pending.
        return {
          _tag: "succeeded",
          terminalChecks: emptyTerminalChecks,
          ...snapshot,
          mergeability: "mergeable",
        } satisfies PullRequestCheckStatus
      }
      if (mergeRequest.state === "closed") {
        // Closed is handled before mergeability in Watch; keep snapshot fields
        // honest but avoid inventing conflict from not_open + cannot_be_merged.
        return {
          _tag: "closed",
          ...snapshot,
          mergeability:
            snapshot.mergeability === "conflicting"
              ? "mergeable"
              : snapshot.mergeability,
        } satisfies PullRequestCheckStatus
      }
      // state opened | locked: keep observing head pipeline (locked is
      // short-lived mid-merge, not terminal).

      const headPipeline = mergeRequest.head_pipeline
      if (headPipeline === null || headPipeline === undefined) {
        return {
          _tag: "no_checks",
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      // Branch or tip-aligned MR pipeline still reports a prior tip after a
      // concurrent push: keep watching (pending) so Merge does not thrash
      // revalidation on a stale green. Merged-results pipelines
      // (`refs/merge-requests/N/merge`) are never stale solely because their
      // SHA differs from the source tip.
      if (isStaleHeadPipelineForTip(mergeRequest)) {
        return {
          _tag: "pending",
          terminalChecks: emptyTerminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }

      /**
       * List pipeline jobs or bridges. 404 is empty (missing/expired pipeline
       * listing), not project-unavailable — the MR already loaded successfully.
       * Other errors still fail the Watch step.
       */
      const listPipelineJobsOrEmpty = (
        pathSuffix: "jobs" | "bridges",
        message: string,
      ): Effect.Effect<readonly PipelineJob[], GitLabServiceError> =>
        requestPages(
          repository,
          `${project}/pipelines/${headPipeline.id}/${pathSuffix}`,
          message,
        ).pipe(
          Effect.flatMap((values) =>
            decodeEffect(
              Schema.Array(PipelineJobSchema),
              values,
              `GitLab returned invalid pipeline ${pathSuffix} for ${repository.projectPath}`,
            ),
          ),
          Effect.catch((error) =>
            error instanceof GitLabRequestError && error.statusCode === 404
              ? Effect.succeed([] as readonly PipelineJob[])
              : Effect.fail(error),
          ),
        )

      const ordinaryJobs = yield* listPipelineJobsOrEmpty(
        "jobs",
        `Failed to list pipeline jobs for ${repository.projectPath} pipeline ${headPipeline.id}`,
      )
      // Bridge/trigger jobs are not included in /jobs. Parent pipelines that
      // mainly spawn child pipelines would otherwise look empty or incomplete.
      const bridgeJobs = yield* listPipelineJobsOrEmpty(
        "bridges",
        `Failed to list pipeline bridge jobs for ${repository.projectPath} pipeline ${headPipeline.id}`,
      )

      const jobs = mergePipelineJobs(ordinaryJobs, bridgeJobs)
      const terminalChecks = toTerminalChecks(jobs)
      let aggregate = aggregatePipelineStatus(jobs)
      if (aggregate === "no_checks" && jobs.length === 0) {
        // Truly empty job+bridge list: use pipeline status so a still-running
        // or failed empty pipeline does not settle as no_checks. When jobs
        // exist but are all ignore (manual/skipped/…), keep no_checks so
        // manual-only pipelines do not requeue forever.
        aggregate = aggregateEmptyJobsFromPipelineStatus(headPipeline.status)
      }
      if (aggregate === "pending") {
        return {
          _tag: "pending",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      if (aggregate === "failed") {
        return {
          _tag: "failed",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      if (aggregate === "succeeded") {
        return {
          _tag: "succeeded",
          terminalChecks,
          ...snapshot,
        } satisfies PullRequestCheckStatus
      }
      return {
        _tag: "no_checks",
        ...snapshot,
      } satisfies PullRequestCheckStatus
    }),
    getPrStatusCheckDiagnostics: Effect.fn(
      "GitLabService.getPrStatusCheckDiagnostics",
    )(function* (repository, checks, options = {}) {
      if (checks.length === 0) {
        return []
      }
      const maxExcerptChars =
        typeof options.maxExcerptChars === "number" &&
        Number.isSafeInteger(options.maxExcerptChars) &&
        options.maxExcerptChars > 0
          ? options.maxExcerptChars
          : DEFAULT_MAX_EXCERPT_CHARS
      const logDirectory =
        typeof options.logDirectory === "string" &&
        options.logDirectory.trim() !== ""
          ? options.logDirectory
          : undefined
      if (logDirectory !== undefined) {
        yield* Effect.tryPromise({
          try: () => mkdir(logDirectory, { recursive: true }),
          catch: (cause) =>
            requestError(
              `Failed to create PR Status Check diagnostic log directory for ${repository.projectPath}`,
              cause,
            ),
        })
      }

      const project = projectApiPath(repository)
      const diagnostics: PrStatusCheckDiagnostic[] = []
      for (const check of checks) {
        const jobId = parseGitlabJobId(check.externalId)
        if (jobId === null) {
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source: "unknown",
            htmlUrl: null,
            logFetch: {
              _tag: "unavailable",
              reason: `No GitLab job id available for external id ${check.externalId}`,
            },
          })
          continue
        }

        const jobMetaResult = yield* requestUnknown(
          repository,
          `${project}/jobs/${jobId}`,
          `Failed to load GitLab job ${jobId} for ${repository.projectPath}`,
        ).pipe(Effect.result)

        let htmlUrl: string | null = null
        if (Result.isSuccess(jobMetaResult)) {
          const job = yield* Effect.try({
            try: () => decode(PipelineJobSchema, jobMetaResult.success),
            catch: () => null as null,
          }).pipe(Effect.orElseSucceed(() => null))
          if (job !== null) {
            htmlUrl =
              typeof job.web_url === "string" && job.web_url.trim() !== ""
                ? job.web_url
                : null
          }
        }

        const traceResult = yield* requestText(
          repository,
          `${project}/jobs/${jobId}/trace`,
          `Failed to load GitLab job trace for job ${jobId} on ${repository.projectPath}`,
        ).pipe(Effect.result)

        if (Result.isFailure(traceResult)) {
          diagnostics.push({
            externalId: check.externalId,
            name: check.name,
            source: "gitlab-job",
            htmlUrl,
            logFetch: {
              _tag: "unavailable",
              reason: traceResult.failure.message,
            },
          })
          continue
        }

        const logText = traceResult.success
        let localPath: string | null = null
        if (logDirectory !== undefined) {
          const path = join(logDirectory, safeLogFileName(check.externalId))
          yield* Effect.tryPromise({
            try: () => writeFile(path, logText, "utf8"),
            catch: (cause) =>
              requestError(
                `Failed to write PR Status Check diagnostic log for ${check.externalId}`,
                cause,
              ),
          })
          localPath = path
        }
        diagnostics.push({
          externalId: check.externalId,
          name: check.name,
          source: "gitlab-job",
          htmlUrl,
          logFetch: {
            _tag: "ok",
            excerpt: boundLogExcerpt(logText, maxExcerptChars),
            localPath,
          },
        })
      }
      return diagnostics
    }),
    markPullRequestReadyForReview: Effect.fn(
      "GitLabService.markPullRequestReadyForReview",
    )(function* (repository, headRefName) {
      const open = yield* unavailableOn404(
        repository,
        listOpenMergeRequestsForBranch(repository, headRefName),
      )
      const listed = open[0]
      if (listed === undefined) {
        return yield* new GitLabRequestError({
          message: `No open merge request found for ${repository.projectPath}:${headRefName}`,
        })
      }

      const project = projectApiPath(repository)
      // Single-MR 404 after open list is a request failure, not project-unavailable.
      const mergeRequest = yield* requestUnknown(
        repository,
        `${project}/merge_requests/${listed.iid}`,
        `Failed to load merge request !${listed.iid} for ${repository.projectPath}`,
      ).pipe(
        Effect.flatMap((value) =>
          decodeMergeRequestCheck(
            value,
            `GitLab returned an invalid merge request for ${repository.projectPath}:${headRefName}`,
          ),
        ),
      )

      if (mergeRequest.state === "closed") {
        return yield* new GitLabRequestError({
          message: `Merge request for ${repository.projectPath}:${headRefName} is closed`,
        })
      }
      if (mergeRequest.state === "merged") {
        return yield* new GitLabRequestError({
          message: `Merge request for ${repository.projectPath}:${headRefName} is merged`,
        })
      }
      // opened | locked: still mutable for mark-ready when draft.
      if (!isDraftMergeRequest(mergeRequest)) {
        return
      }

      const currentTitle = mergeRequest.title ?? ""
      const readyTitle = stripDraftTitlePrefix(currentTitle)
      const updated = yield* requestUnknown(
        repository,
        `${project}/merge_requests/${mergeRequest.iid}`,
        `Failed to mark merge request !${mergeRequest.iid} ready for review for ${repository.projectPath}`,
        {
          method: "PUT",
          body: {
            draft: false,
            title: readyTitle,
          },
        },
      ).pipe(
        Effect.flatMap((value) =>
          decodeMergeRequestCheck(
            value,
            `GitLab returned an invalid merge request after mark ready for ${repository.projectPath}:${headRefName}`,
          ),
        ),
      )
      if (isDraftMergeRequest(updated)) {
        return yield* new GitLabRequestError({
          message: `Merge request for ${repository.projectPath}:${headRefName} is still a draft`,
        })
      }
    }),
    getPullRequestLifecycleStatus: Effect.fn(
      "GitLabService.getPullRequestLifecycleStatus",
    )(function* (repository, headRefName) {
      const mergeRequestIid = yield* resolveMergeRequestIidForBranch(
        repository,
        headRefName,
      )
      if (mergeRequestIid === null) {
        return { _tag: "not_found" } satisfies PullRequestLifecycleStatus
      }
      const project = projectApiPath(repository)
      const mergeRequestLoad = yield* requestUnknown(
        repository,
        `${project}/merge_requests/${mergeRequestIid}`,
        `Failed to load merge request !${mergeRequestIid} for ${repository.projectPath}`,
      ).pipe(
        Effect.flatMap((value) =>
          decodeMergeRequestCheck(
            value,
            `GitLab returned an invalid merge request for ${repository.projectPath}:${headRefName}`,
          ),
        ),
        Effect.result,
      )
      if (Result.isFailure(mergeRequestLoad)) {
        if (
          mergeRequestLoad.failure instanceof GitLabRequestError &&
          mergeRequestLoad.failure.statusCode === 404
        ) {
          return { _tag: "not_found" } satisfies PullRequestLifecycleStatus
        }
        return yield* mergeRequestLoad.failure
      }
      const mergeRequest = mergeRequestLoad.success
      if (mergeRequest.state === "merged") {
        return { _tag: "merged" } satisfies PullRequestLifecycleStatus
      }
      if (mergeRequest.state === "closed") {
        return { _tag: "closed" } satisfies PullRequestLifecycleStatus
      }
      // opened | locked: still open for lifecycle purposes (locked is mid-merge).
      if (mergeRequest.state === "opened" || mergeRequest.state === "locked") {
        return { _tag: "open" } satisfies PullRequestLifecycleStatus
      }
      return yield* new GitLabRequestError({
        message: `GitLab returned an invalid merge request state for ${repository.projectPath}:${headRefName}`,
      })
    }),
    mergePullRequest: Effect.fn("GitLabService.mergePullRequest")(
      function* (repository, headRefName, options) {
        const loadMergeRequest = (): Effect.Effect<
          MergeRequestCheck | null,
          GitLabServiceError
        > =>
          Effect.gen(function* () {
            const mergeRequestIid = yield* resolveMergeRequestIidForBranch(
              repository,
              headRefName,
            )
            if (mergeRequestIid === null) return null
            const project = projectApiPath(repository)
            const mergeRequestLoad = yield* requestUnknown(
              repository,
              `${project}/merge_requests/${mergeRequestIid}`,
              `Failed to load merge request !${mergeRequestIid} for ${repository.projectPath}`,
            ).pipe(
              Effect.flatMap((value) =>
                decodeMergeRequestCheck(
                  value,
                  `GitLab returned an invalid merge request for ${repository.projectPath}:${headRefName}`,
                ),
              ),
              Effect.result,
            )
            if (Result.isFailure(mergeRequestLoad)) {
              if (
                mergeRequestLoad.failure instanceof GitLabRequestError &&
                mergeRequestLoad.failure.statusCode === 404
              ) {
                return null
              }
              return yield* mergeRequestLoad.failure
            }
            return mergeRequestLoad.success
          })

        /**
         * Job-level pipeline rollup for merge pre-checks. Matches Watch so
         * allow_failure failures are not hard-fail, while still-running and
         * hard-fail pipelines revalidate. An absent head pipeline or a
         * no_checks aggregate (including skipped-only / ignore-only jobs) is
         * not green unless Always accepts `no_checks`. A tip-aligned
         * head_pipeline whose SHA is not the MR tip is treated as not green so
         * a concurrent push cannot merge an untested head under a stale
         * success (same tip-freshness rule as Watch pending). Merged-results
         * pipelines are excluded from that SHA rule.
         */
        const pipelineBlockingReason = (
          mergeRequest: MergeRequestCheck,
        ): Effect.Effect<
          "checks_not_green" | "missing_successful_checks" | null,
          GitLabServiceError
        > =>
          Effect.gen(function* () {
            const headPipeline = mergeRequest.head_pipeline
            if (headPipeline === null || headPipeline === undefined) {
              return options?.acceptNoChecks === true
                ? null
                : ("missing_successful_checks" as const)
            }
            if (isStaleHeadPipelineForTip(mergeRequest)) {
              return "checks_not_green" as const
            }
            const project = projectApiPath(repository)
            const listPipelineJobsOrEmpty = (
              pathSuffix: "jobs" | "bridges",
              message: string,
            ): Effect.Effect<readonly PipelineJob[], GitLabServiceError> =>
              requestPages(
                repository,
                `${project}/pipelines/${headPipeline.id}/${pathSuffix}`,
                message,
              ).pipe(
                Effect.flatMap((values) =>
                  decodeEffect(
                    Schema.Array(PipelineJobSchema),
                    values,
                    `GitLab returned invalid pipeline ${pathSuffix} for ${repository.projectPath}`,
                  ),
                ),
                Effect.catch((error) =>
                  error instanceof GitLabRequestError &&
                  error.statusCode === 404
                    ? Effect.succeed([] as readonly PipelineJob[])
                    : Effect.fail(error),
                ),
              )
            const ordinaryJobs = yield* listPipelineJobsOrEmpty(
              "jobs",
              `Failed to list pipeline jobs for ${repository.projectPath} pipeline ${headPipeline.id}`,
            )
            const bridgeJobs = yield* listPipelineJobsOrEmpty(
              "bridges",
              `Failed to list pipeline bridge jobs for ${repository.projectPath} pipeline ${headPipeline.id}`,
            )
            const jobs = mergePipelineJobs(ordinaryJobs, bridgeJobs)
            let aggregate = aggregatePipelineStatus(jobs)
            if (aggregate === "no_checks" && jobs.length === 0) {
              aggregate = aggregateEmptyJobsFromPipelineStatus(
                headPipeline.status,
              )
            }
            if (aggregate === "pending" || aggregate === "failed") {
              return "checks_not_green" as const
            }
            if (aggregate === "no_checks") {
              return options?.acceptNoChecks === true
                ? null
                : ("missing_successful_checks" as const)
            }
            return null
          })

        const classifyOpenMergeRequest = (
          mergeRequest: MergeRequestCheck,
        ): Effect.Effect<
          | MergePullRequestResult
          | { readonly _tag: "ready"; readonly sha: string },
          GitLabServiceError
        > =>
          Effect.gen(function* () {
            if (mergeRequest.state === "merged") {
              return { _tag: "merged" } as const
            }
            if (mergeRequest.state === "closed") {
              return {
                _tag: "needs_human" as const,
                reason: "closed_unmerged" as const,
                message: `Merge request for ${repository.projectPath}:${headRefName} was closed without merging`,
              }
            }
            if (mergeRequest.state === "locked") {
              return {
                _tag: "revalidation" as const,
                reason: "mergeability_changed" as const,
                message: `Merge request is locked (merge in progress) for ${repository.projectPath}:${headRefName}`,
              }
            }
            if (mergeRequest.state !== "opened") {
              return yield* new GitLabRequestError({
                message: `GitLab returned an invalid merge request state for ${repository.projectPath}:${headRefName}`,
              })
            }
            if (isDraftMergeRequest(mergeRequest)) {
              return {
                _tag: "revalidation" as const,
                reason: "mergeability_changed" as const,
                message: `Merge request is still a draft for ${repository.projectPath}:${headRefName}`,
              }
            }
            const headSha =
              typeof mergeRequest.sha === "string" &&
              mergeRequest.sha.trim() !== ""
                ? mergeRequest.sha
                : null
            if (headSha === null) {
              return yield* new GitLabRequestError({
                message: `GitLab returned an invalid merge request head for ${repository.projectPath}:${headRefName}`,
              })
            }
            const pipelineBlock = yield* pipelineBlockingReason(mergeRequest)
            if (pipelineBlock === "missing_successful_checks") {
              return {
                _tag: "needs_human" as const,
                reason: "missing_successful_checks" as const,
                message: `No successful pipeline jobs were reported for ${repository.projectPath}:${headRefName}`,
              }
            }
            if (pipelineBlock === "checks_not_green") {
              return {
                _tag: "revalidation" as const,
                reason: "checks_not_green" as const,
                message: `Merge request pipeline is no longer successful for ${repository.projectPath}:${headRefName}`,
              }
            }
            const mergeability = mapMergeability(mergeRequest)
            if (mergeability !== "mergeable") {
              return {
                _tag: "revalidation" as const,
                reason: "mergeability_changed" as const,
                message: `Merge request mergeability is ${mergeability} for ${repository.projectPath}:${headRefName}`,
              }
            }
            return { _tag: "ready" as const, sha: headSha }
          })

        const initial = yield* loadMergeRequest()
        if (initial === null) {
          return yield* new GitLabRequestError({
            message: `No merge request found for ${repository.projectPath}:${headRefName}`,
          })
        }
        const prepared = yield* classifyOpenMergeRequest(initial)
        if (prepared._tag !== "ready") {
          return prepared
        }
        const expectedHeadSha = prepared.sha
        const mergeRequestIid = initial.iid
        const project = projectApiPath(repository)

        // Do not set squash / merge_commit_message: project GitLab settings govern.
        const mergeResult = yield* requestUnknown(
          repository,
          `${project}/merge_requests/${mergeRequestIid}/merge`,
          `Failed to merge merge request !${mergeRequestIid} for ${repository.projectPath}`,
          {
            method: "PUT",
            body: {
              sha: expectedHeadSha,
            },
          },
        ).pipe(Effect.result)

        if (Result.isSuccess(mergeResult)) {
          const merged = yield* decodeMergeRequestCheck(
            mergeResult.success,
            `GitLab returned an invalid merge request after merge for ${repository.projectPath}:${headRefName}`,
          )
          if (merged.state === "merged") {
            return { _tag: "merged" } as const
          }
          if (merged.state === "closed") {
            return {
              _tag: "needs_human" as const,
              reason: "closed_unmerged" as const,
              message: `Merge request for ${repository.projectPath}:${headRefName} was concurrently closed without merging`,
            }
          }
          // Unexpected non-merged success body: re-fetch and classify.
        } else {
          const failure = mergeResult.failure
          const statusCode = failure.statusCode
          // Operational: auth, missing project, transport, 5xx, etc.
          // Handled rejections (405/406/409/422) re-fetch and classify.
          if (
            statusCode !== 405 &&
            statusCode !== 406 &&
            statusCode !== 409 &&
            statusCode !== 422
          ) {
            return yield* failure
          }
        }

        const refreshed = yield* loadMergeRequest()
        if (refreshed === null) {
          return yield* new GitLabRequestError({
            message: `GitLab did not return a merge request after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        if (refreshed.state === "merged") {
          return { _tag: "merged" } as const
        }
        if (refreshed.state === "closed") {
          return {
            _tag: "needs_human" as const,
            reason: "closed_unmerged" as const,
            message: `Merge request for ${repository.projectPath}:${headRefName} was concurrently closed without merging`,
          }
        }
        if (refreshed.state === "locked") {
          return {
            _tag: "revalidation" as const,
            reason: "mergeability_changed" as const,
            message: `Merge request became locked while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        if (refreshed.state !== "opened") {
          return yield* new GitLabRequestError({
            message: `GitLab returned an invalid merge request state after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        // Match pre-check: draft is repairable revalidation, not merge_rejected.
        if (isDraftMergeRequest(refreshed)) {
          return {
            _tag: "revalidation" as const,
            reason: "mergeability_changed" as const,
            message: `Merge request is still a draft for ${repository.projectPath}:${headRefName}`,
          }
        }
        const refreshedSha =
          typeof refreshed.sha === "string" && refreshed.sha.trim() !== ""
            ? refreshed.sha
            : null
        if (refreshedSha === null) {
          return yield* new GitLabRequestError({
            message: `GitLab returned an invalid merge request head after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        if (refreshedSha !== expectedHeadSha) {
          return {
            _tag: "revalidation" as const,
            reason: "head_changed" as const,
            message: `Merge request head changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        // GitLab 409 means the expected head SHA was rejected. Always classify
        // as head_changed after refresh (authoritative even if the re-fetched
        // tip still equals expectedHeadSha — e.g. eventual consistency).
        if (
          Result.isFailure(mergeResult) &&
          mergeResult.failure.statusCode === 409
        ) {
          return {
            _tag: "revalidation" as const,
            reason: "head_changed" as const,
            message: `Merge request head changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        const pipelineBlock = yield* pipelineBlockingReason(refreshed)
        if (pipelineBlock === "missing_successful_checks") {
          return {
            _tag: "needs_human" as const,
            reason: "missing_successful_checks" as const,
            message: `No successful pipeline jobs were reported while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        if (pipelineBlock === "checks_not_green") {
          return {
            _tag: "revalidation" as const,
            reason: "checks_not_green" as const,
            message: `Merge request pipeline changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        const mergeability = mapMergeability(refreshed)
        if (mergeability === "conflicting" || mergeability === "unknown") {
          return {
            _tag: "revalidation" as const,
            reason: "mergeability_changed" as const,
            message: `Merge request mergeability changed while merging ${repository.projectPath}:${headRefName}`,
          }
        }
        if (mergeability !== "mergeable") {
          return yield* new GitLabRequestError({
            message: `GitLab returned invalid mergeability after merge for ${repository.projectPath}:${headRefName}`,
          })
        }
        return {
          _tag: "needs_human" as const,
          reason: "merge_rejected" as const,
          message: `GitLab rejected the unchanged, open, green, mergeable merge request for ${repository.projectPath}:${headRefName}`,
        } satisfies MergePullRequestResult
      },
    ),
    ensureIssueCompletedWithSummary: Effect.fn(
      "GitLabService.ensureIssueCompletedWithSummary",
    )(function* (repository, issueNumber, workItemId, summaryMarkdown) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        return yield* new GitLabRequestError({
          message: `Invalid Issue number for ${repository.projectPath}: ${String(issueNumber)}`,
        })
      }
      if (typeof workItemId !== "string" || workItemId.trim() === "") {
        return yield* new GitLabRequestError({
          message: `Invalid Work Item id for ${repository.projectPath}#${issueNumber}`,
        })
      }
      if (
        typeof summaryMarkdown !== "string" ||
        summaryMarkdown.trim() === ""
      ) {
        return yield* new GitLabRequestError({
          message: `Empty completion summary for ${repository.projectPath}#${issueNumber}`,
        })
      }

      const marker = workItemCompletionMarker(workItemId)
      const issueRef = `${repository.projectPath}#${issueNumber}`
      const project = projectApiPath(repository)
      const issuePath = `${project}/issues/${issueNumber}`

      const issue = yield* unavailableOn404(
        repository,
        requestUnknown(
          repository,
          issuePath,
          `Failed to load Issue ${issueRef}`,
        ).pipe(
          Effect.map((value) => decode(IssueStateSchema, value)),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError(
                  `GitLab returned an invalid Issue for ${issueRef}`,
                  error,
                ),
          ),
        ),
      )

      const notes = yield* unavailableOn404(
        repository,
        requestPages(
          repository,
          `${issuePath}/notes?sort=asc&order_by=created_at`,
          `Failed to list comments for Issue ${issueRef}`,
        ).pipe(
          Effect.map((values) => decode(Schema.Array(NoteSchema), values)),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError(
                  `GitLab returned invalid notes for ${issueRef}`,
                  error,
                ),
          ),
        ),
      )

      const hasMarkedComment = notes.some(
        (note) => typeof note.body === "string" && note.body.includes(marker),
      )

      if (!hasMarkedComment) {
        const body = `${summaryMarkdown.trimEnd()}\n\n${marker}`
        const posted = yield* unavailableOn404(
          repository,
          requestUnknown(
            repository,
            `${issuePath}/notes`,
            `Failed to post completion summary on Issue ${issueRef}`,
            {
              method: "POST",
              body: { body },
            },
          ).pipe(
            Effect.map((value) => decode(NoteSchema, value)),
            Effect.mapError((error) =>
              error instanceof GitLabRequestError
                ? error
                : requestError(
                    `GitLab returned an invalid note after posting on ${issueRef}`,
                    error,
                  ),
            ),
          ),
        )
        if (typeof posted.body !== "string" || !posted.body.includes(marker)) {
          return yield* new GitLabRequestError({
            message: `GitLab did not return a marked completion comment for ${issueRef}`,
          })
        }
      }

      if (issue.state === "closed") {
        return
      }

      const closed = yield* unavailableOn404(
        repository,
        requestUnknown(
          repository,
          issuePath,
          `Failed to close Issue ${issueRef}`,
          {
            method: "PUT",
            body: { state_event: "close" },
          },
        ).pipe(
          Effect.map((value) => decode(IssueStateSchema, value)),
          Effect.mapError((error) =>
            error instanceof GitLabRequestError
              ? error
              : requestError(
                  `GitLab returned an invalid Issue after closing ${issueRef}`,
                  error,
                ),
          ),
        ),
      )
      if (closed.state !== "closed") {
        return yield* new GitLabRequestError({
          message: `Issue ${issueRef} is still open after close`,
        })
      }
    }),
    closeOpenPullRequestsForBranch: Effect.fn(
      "GitLabService.closeOpenPullRequestsForBranch",
    )(function* (repository, headRefName) {
      const open = yield* unavailableOn404(
        repository,
        listOpenMergeRequestsForBranch(repository, headRefName),
      )
      for (const mergeRequest of open) {
        // Missing MR between list and close is success (idempotent cleanup).
        const closeResult = yield* requestUnknown(
          repository,
          `${projectApiPath(repository)}/merge_requests/${mergeRequest.iid}`,
          `Failed to close merge request !${mergeRequest.iid} for ${repository.projectPath}`,
          {
            method: "PUT",
            body: { state_event: "close" },
          },
        ).pipe(Effect.asVoid, Effect.result)
        if (closeResult._tag === "Success") continue
        if (closeResult.failure.statusCode === 404) continue
        return yield* closeResult.failure
      }
    }),
    deleteBranch: Effect.fn("GitLabService.deleteBranch")(
      function* (repository, branchName) {
        const result = yield* requestUnknown(
          repository,
          `${projectApiPath(repository)}/repository/branches/${encodeURIComponent(branchName)}`,
          `Failed to delete branch ${branchName} on ${repository.projectPath}`,
          {
            method: "DELETE",
            acceptEmpty: true,
          },
        ).pipe(Effect.result)

        if (result._tag === "Success") {
          return
        }
        const error = result.failure
        if (error.statusCode === 404) {
          return
        }
        return yield* error
      },
    ),
  }
}

export const makeGitLabServiceFromToken = (
  token: string,
  fetchImpl: GitLabFetch = fetch,
): GitLabServiceShape => makeGitLabService({ token, fetch: fetchImpl })

/**
 * Helper-process Live layer: reads `GITLAB_TOKEN` from the environment.
 * Keymaxxer injects the named vault secret aliased as `GITLAB_TOKEN` so the
 * raw token never enters the Harness process.
 */
export const GitLabServiceLive = Layer.effect(
  GitLabService,
  Effect.gen(function* () {
    const token = yield* Config.redacted("GITLAB_TOKEN")
    return makeGitLabServiceFromToken(Redacted.value(token))
  }),
)
