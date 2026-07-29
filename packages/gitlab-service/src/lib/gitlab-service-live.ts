import { Config, Duration, Effect, Layer, Redacted, Schema } from "effect"
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
  path_with_namespace: RequiredString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
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

type GitLabIssue = typeof IssueSchema.Type
type GitLabMergeRequest = typeof MergeRequestSchema.Type
type OpenMergeRequest = typeof OpenMergeRequestSchema.Type

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

const apiBase = (repository: GitLabRepository): string =>
  `https://${repository.forgeHost}/api/v4`

const projectApiPath = (repository: GitLabRepository): string =>
  `/projects/${encodeURIComponent(repository.projectPath)}`

const requestError = (message: string, cause: unknown): GitLabRequestError =>
  new GitLabRequestError({
    message,
    cause,
    ...(cause instanceof GitLabHttpError
      ? { statusCode: cause.statusCode }
      : {}),
  })

const decode = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

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

const mapIssue = (
  repository: GitLabRepository,
  issue: GitLabIssue,
  mergeRequests: readonly GitLabMergeRequest[],
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
      .map((mergeRequest) => ({
        number: mergeRequest.iid,
        repository: repository.projectPath,
        state: mergeRequestState(mergeRequest.state),
        isDraft: mergeRequest.draft,
      })),
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

  const listOpenMergeRequestsForBranch = (
    repository: GitLabRepository,
    headRefName: string,
  ): Effect.Effect<readonly OpenMergeRequest[], GitLabRequestError> =>
    requestPages(
      repository,
      `${projectApiPath(repository)}/merge_requests?state=opened&source_branch=${encodeURIComponent(headRefName)}`,
      `Failed to list open merge requests for ${repository.projectPath}:${headRefName}`,
    ).pipe(
      Effect.map((values) =>
        decode(Schema.Array(OpenMergeRequestSchema), values),
      ),
      Effect.mapError((error) =>
        error instanceof GitLabRequestError
          ? error
          : requestError(
              `GitLab returned invalid open merge request data for ${repository.projectPath}:${headRefName}`,
              error,
            ),
      ),
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
          Effect.map((value) => decode(ProjectSchema, value)),
          Effect.asVoid,
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
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(([issues, mergeRequests]) => {
              const decodedIssues = decode(Schema.Array(IssueSchema), issues)
              const decodedMergeRequests = decode(
                Schema.Array(MergeRequestSchema),
                mergeRequests,
              )
              return decodedIssues
                .map((issue) =>
                  mapIssue(repository, issue, decodedMergeRequests),
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
