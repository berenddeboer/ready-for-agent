import { Duration, Effect, Schema } from "effect"
import { GitLabProjectUnavailableError, GitLabRequestError } from "./errors.js"
import type { GitLabServiceShape } from "./gitlab-service.js"
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
const MergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  state: Schema.Literals(["opened", "merged", "closed"]),
  draft: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
})

type GitLabIssue = typeof IssueSchema.Type
type GitLabMergeRequest = typeof MergeRequestSchema.Type

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
  ): Effect.Effect<unknown, GitLabRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${apiBase(repository)}${path}`, {
          headers,
        })
        if (!response.ok) {
          throw new GitLabHttpError(
            response.status,
            `${message}: GitLab returned HTTP ${response.status}`,
          )
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
  }
}

export const makeGitLabServiceFromToken = (
  token: string,
  fetchImpl: GitLabFetch = fetch,
): GitLabServiceShape => makeGitLabService({ token, fetch: fetchImpl })
