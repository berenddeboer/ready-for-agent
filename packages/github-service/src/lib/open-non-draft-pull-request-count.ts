/**
 * Lightweight open non-draft Pull Request count for the high-frequency header
 * path. Intentionally avoids the full GitHubService / genql / Effect helper
 * graph so source-mode Keymaxxer children start quickly.
 *
 * Contracts match {@link GitHubService.countOpenNonDraftPullRequests}:
 * paginated OPEN PRs, draft exclusion, 30s request timeout, two retries with
 * 500ms delay (no retry on HTTP 401), repository-unavailable when GitHub
 * returns a null repository.
 */
import {
  GITHUB_HELPER_THROTTLED_EXIT_CODE,
  type GitHubHelperThrottle,
  githubHelperSuccess,
  githubHelperThrottled,
  serializeGitHubHelperControl,
} from "./github-helper-protocol.js"
import {
  githubThrottleFromResponse,
  githubThrottleFromSuccessfulResponse,
} from "./github-throttle.js"

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_DELAY_MS = 500
const MAX_RETRIES = 2

const COUNT_QUERY = `query CountOpenNonDraftPullRequests($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PAGE_SIZE}, states: [OPEN], after: $after) {
      nodes {
        isDraft
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
}`

export type OpenNonDraftPullRequestCountFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>

export type OpenNonDraftPullRequestCountOk = {
  readonly _tag: "ok"
  readonly count: number
  /** Explicit final-quota evidence observed while completing the count. */
  readonly throttle?: GitHubHelperThrottle
}

export type OpenNonDraftPullRequestCountUnavailable = {
  readonly _tag: "unavailable"
}

export type OpenNonDraftPullRequestCountFailed = {
  readonly _tag: "error"
  readonly message: string
  readonly statusCode?: number
}

export type OpenNonDraftPullRequestCountThrottled = {
  readonly _tag: "throttled"
  readonly retryAt: number
  readonly usedFallback: boolean
}

export type OpenNonDraftPullRequestCountResult =
  | OpenNonDraftPullRequestCountOk
  | OpenNonDraftPullRequestCountUnavailable
  | OpenNonDraftPullRequestCountThrottled
  | OpenNonDraftPullRequestCountFailed

export type OpenNonDraftPullRequestCountInput = {
  readonly token: string
  readonly owner: string
  readonly name: string
  readonly fetchImpl?: OpenNonDraftPullRequestCountFetch
  readonly sleepMs?: (ms: number) => Promise<void>
}

type GraphQlPage = {
  readonly data?: {
    readonly repository?: {
      readonly pullRequests?: {
        readonly nodes?:
          | readonly ({ readonly isDraft?: boolean } | null)[]
          | null
        readonly pageInfo?: {
          readonly endCursor?: string | null
          readonly hasNextPage?: boolean
        }
      } | null
    } | null
  } | null
  readonly errors?: readonly { readonly message?: string }[]
}

class CountHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly headers: Headers,
    message: string,
  ) {
    super(message)
  }
}

class CountThrottledError extends Error {
  constructor(readonly throttle: GitHubHelperThrottle) {
    super("GitHub throttled")
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const projectLabel = (owner: string, name: string): string =>
  name === "" ? owner : `${owner}/${name}`

const toApiRepository = (
  projectPath: string,
): { readonly owner: string; readonly name: string } => {
  const separator = projectPath.indexOf("/")
  if (separator <= 0 || separator === projectPath.length - 1) {
    return { owner: projectPath, name: "" }
  }
  return {
    owner: projectPath.slice(0, separator),
    name: projectPath.slice(separator + 1),
  }
}

const decodeBase64Url = (value: string | undefined, name: string): string => {
  if (value === undefined || value === "") {
    throw new Error(`Missing ${name} argument`)
  }
  return Buffer.from(value, "base64url").toString("utf8")
}

const fetchGraphQlPage = async (
  input: {
    readonly token: string
    readonly owner: string
    readonly name: string
    readonly after: string | null
    readonly fetchImpl: OpenNonDraftPullRequestCountFetch
    readonly observeSuccessfulThrottle: (throttle: GitHubHelperThrottle) => void
  },
  signal: AbortSignal,
): Promise<GraphQlPage> => {
  const response = await input.fetchImpl(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: COUNT_QUERY,
      variables: {
        owner: input.owner,
        name: input.name,
        after: input.after,
      },
    }),
    signal,
  })

  if (!response.ok) {
    const body = await response.text()
    const message = `${response.statusText}: ${body.slice(0, 300)}`
    const throttle = githubThrottleFromResponse({
      statusCode: response.status,
      headers: response.headers,
      message,
    })
    if (throttle !== undefined) throw new CountThrottledError(throttle)
    throw new CountHttpError(response.status, response.headers, message)
  }

  const page = (await response.json()) as GraphQlPage
  // Match genql: any GraphQL `errors` array is a failure (retryable), even when
  // partial `data` is present. Clean `{ repository: null }` without errors is
  // handled by the caller as repository-unavailable.
  if (page.errors !== undefined && page.errors.length > 0) {
    const message = page.errors
      .map((error) =>
        typeof error.message === "string" && error.message.trim() !== ""
          ? error.message
          : "GraphQL error",
      )
      .join("\n")
    const throttle = githubThrottleFromResponse({
      statusCode: response.status,
      headers: response.headers,
      message,
    })
    if (throttle !== undefined) throw new CountThrottledError(throttle)
    throw new Error(message)
  }
  const throttle = githubThrottleFromSuccessfulResponse({
    headers: response.headers,
  })
  if (throttle !== undefined) input.observeSuccessfulThrottle(throttle)
  return page
}

const withTimeoutAndRetry = async <A>(
  message: string,
  request: (signal: AbortSignal) => Promise<A>,
  sleepMs: (ms: number) => Promise<void>,
): Promise<A> => {
  let attempt = 0
  // Explicit loop result type avoids circular inference when A is inferred from
  // a request that closes over mutable pagination state.
  let lastError: (Error & { statusCode?: number }) | undefined
  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const value: A = await request(controller.signal)
      return value
    } catch (cause) {
      if (cause instanceof CountThrottledError) throw cause
      const statusCode =
        cause instanceof CountHttpError ? cause.statusCode : undefined
      const timedOut =
        cause instanceof Error &&
        (cause.name === "AbortError" || /aborted/i.test(cause.message))
      const failMessage = timedOut ? `${message} timed out` : message
      const detail =
        cause instanceof Error && cause.message.trim() !== ""
          ? cause.message
          : undefined
      const error = new Error(
        detail === undefined ? failMessage : `${failMessage}: ${detail}`,
      ) as Error & { statusCode?: number }
      if (statusCode !== undefined) {
        error.statusCode = statusCode
      }
      lastError = error
      if (statusCode === 401 || attempt >= MAX_RETRIES) {
        throw error
      }
      attempt += 1
      await sleepMs(RETRY_DELAY_MS)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error(message)
}

/**
 * Count currently open, non-draft pull requests via GitHub GraphQL.
 * Does not log or return the token.
 */
export const countOpenNonDraftPullRequestsLite = async (
  input: OpenNonDraftPullRequestCountInput,
): Promise<OpenNonDraftPullRequestCountResult> => {
  const fetchImpl = input.fetchImpl ?? fetch
  const sleepMs = input.sleepMs ?? defaultSleep
  const label = projectLabel(input.owner, input.name)
  let count = 0
  let cursor: string | null = null
  let observedThrottle: GitHubHelperThrottle | undefined
  const observeSuccessfulThrottle = (throttle: GitHubHelperThrottle): void => {
    if (
      observedThrottle === undefined ||
      throttle.retryAt > observedThrottle.retryAt
    ) {
      observedThrottle = throttle
    }
  }

  try {
    for (;;) {
      const afterCursor: string | null = cursor
      const page: GraphQlPage = await withTimeoutAndRetry<GraphQlPage>(
        `Failed to count open pull requests for ${label}`,
        (signal: AbortSignal): Promise<GraphQlPage> =>
          fetchGraphQlPage(
            {
              token: input.token,
              owner: input.owner,
              name: input.name,
              after: afterCursor,
              fetchImpl,
              observeSuccessfulThrottle,
            },
            signal,
          ),
        sleepMs,
      )

      if (page.data?.repository == null) {
        return { _tag: "unavailable" }
      }

      const nodes = page.data.repository.pullRequests?.nodes ?? []
      for (const node of nodes) {
        if (node !== null && node !== undefined && node.isDraft === false) {
          count += 1
        }
      }

      const pageInfo:
        | {
            readonly endCursor?: string | null
            readonly hasNextPage?: boolean
          }
        | undefined = page.data.repository.pullRequests?.pageInfo
      if (
        pageInfo?.hasNextPage !== true ||
        pageInfo.endCursor === null ||
        pageInfo.endCursor === undefined ||
        pageInfo.endCursor === ""
      ) {
        break
      }
      cursor = pageInfo.endCursor
    }
    return observedThrottle === undefined
      ? { _tag: "ok", count }
      : { _tag: "ok", count, throttle: observedThrottle }
  } catch (cause) {
    if (cause instanceof CountThrottledError) {
      return {
        _tag: "throttled",
        retryAt: cause.throttle.retryAt,
        usedFallback: cause.throttle.usedFallback,
      }
    }
    const statusCode =
      typeof cause === "object" &&
      cause !== null &&
      "statusCode" in cause &&
      typeof (cause as { statusCode: unknown }).statusCode === "number"
        ? (cause as { statusCode: number }).statusCode
        : undefined
    const message = `Failed to count open pull requests for ${label}`
    return statusCode === undefined
      ? { _tag: "error", message }
      : { _tag: "error", message, statusCode }
  }
}

export type OpenNonDraftPullRequestCountCliResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * CLI body for the dedicated count helper process.
 * Args are base64url-encoded forge, forgeHost, projectPath (same as other helpers).
 * Token is read only from `GITHUB_TOKEN` in the process environment.
 */
export const runOpenNonDraftPullRequestCountCli = async (
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: NodeJS.ProcessEnv
    readonly fetchImpl?: OpenNonDraftPullRequestCountFetch
    readonly sleepMs?: (ms: number) => Promise<void>
  },
): Promise<OpenNonDraftPullRequestCountCliResult> => {
  try {
    const env = options?.env ?? process.env
    const token = env.GITHUB_TOKEN
    if (token === undefined || token.trim() === "") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to count open pull requests: missing GITHUB_TOKEN\n",
      }
    }

    // forge and forgeHost are accepted for argv compatibility with other helpers.
    decodeBase64Url(args[0], "forge")
    decodeBase64Url(args[1], "forge host")
    const projectPath = decodeBase64Url(args[2], "project path")
    const { owner, name } = toApiRepository(projectPath)

    const result = await countOpenNonDraftPullRequestsLite({
      token,
      owner,
      name,
      fetchImpl: options?.fetchImpl,
      sleepMs: options?.sleepMs,
    })

    if (result._tag === "ok") {
      return {
        exitCode: 0,
        stdout: String(result.count),
        stderr: serializeGitHubHelperControl(
          result.throttle === undefined
            ? githubHelperSuccess()
            : githubHelperSuccess({ throttle: result.throttle }),
        ),
      }
    }
    if (result._tag === "unavailable") {
      return { exitCode: 2, stdout: "", stderr: "" }
    }
    if (result._tag === "throttled") {
      return {
        exitCode: GITHUB_HELPER_THROTTLED_EXIT_CODE,
        stdout: "",
        stderr: serializeGitHubHelperControl(githubHelperThrottled(result)),
      }
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Failed to count open pull requests\n",
    }
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Failed to count open pull requests\n",
    }
  }
}
