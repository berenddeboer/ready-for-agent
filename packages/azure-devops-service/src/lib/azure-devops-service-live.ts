import { Config, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { extractErrorCode } from "@ready-for-agent/github-service"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "./azure-devops-service.js"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
} from "./errors.js"
import {
  AZURE_DEVOPS_FORGE_HOST,
  AZURE_DEVOPS_PAT_ENV_VAR,
  type AzureDevOpsRepository,
  splitAzureDevOpsProjectPath,
} from "./types.js"

const REQUEST_TIMEOUT = Duration.seconds(30)
/** Azure DevOps REST API version pinned for stable response shapes. */
const API_VERSION = "7.1"

type AzureDevOpsFetch = typeof fetch

class AzureDevOpsHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)

const ProjectSchema = Schema.Struct({
  id: Schema.optional(RequiredString),
  name: RequiredString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const ConnectionDataSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({
    id: Schema.optional(Schema.String),
    providerDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const decode = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

const organizationApiBase = (organization: string): string =>
  `https://${AZURE_DEVOPS_FORGE_HOST}/${encodeURIComponent(organization)}`

const requestError = (
  message: string,
  cause: unknown,
): AzureDevOpsRequestError => {
  const code = extractErrorCode(cause)
  return new AzureDevOpsRequestError({
    message,
    cause,
    ...(code !== undefined ? { code } : {}),
    ...(cause instanceof AzureDevOpsHttpError
      ? { statusCode: cause.statusCode }
      : {}),
  })
}

const invalidProjectPath = (
  repository: AzureDevOpsRepository,
): AzureDevOpsRequestError =>
  new AzureDevOpsRequestError({
    message: `Invalid Azure DevOps Project Path (expected <organization>/<project>): ${repository.projectPath}`,
  })

const notImplemented = (
  method: string,
): Effect.Effect<never, AzureDevOpsNotImplementedError> =>
  Effect.fail(new AzureDevOpsNotImplementedError({ method }))

export const makeAzureDevOpsService = (options: {
  readonly token?: string
  readonly fetch?: AzureDevOpsFetch
}): AzureDevOpsServiceShape => {
  const fetchImpl = options.fetch ?? fetch
  const headers: Record<string, string> =
    options.token === undefined || options.token.trim() === ""
      ? { Accept: "application/json" }
      : {
          Accept: "application/json",
          // Azure DevOps PAT auth: HTTP Basic with an empty username.
          Authorization: `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`,
        }

  const requestUnknown = (
    organization: string,
    path: string,
    message: string,
  ): Effect.Effect<unknown, AzureDevOpsRequestError> =>
    Effect.tryPromise({
      try: async () => {
        const separator = path.includes("?") ? "&" : "?"
        const response = await fetchImpl(
          `${organizationApiBase(organization)}${path}${separator}api-version=${API_VERSION}`,
          { method: "GET", headers },
        )
        if (!response.ok) {
          throw new AzureDevOpsHttpError(
            response.status,
            `${message}: Azure DevOps returned HTTP ${response.status}`,
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

  const unavailableOn404 = <A>(
    repository: AzureDevOpsRepository,
    effect: Effect.Effect<A, AzureDevOpsRequestError>,
  ): Effect.Effect<
    A,
    AzureDevOpsProjectUnavailableError | AzureDevOpsRequestError
  > =>
    effect.pipe(
      Effect.catch(
        (
          error,
        ): Effect.Effect<
          never,
          AzureDevOpsProjectUnavailableError | AzureDevOpsRequestError
        > =>
          error.statusCode === 404
            ? Effect.fail(new AzureDevOpsProjectUnavailableError(repository))
            : Effect.fail(error),
      ),
    )

  return {
    verifyProject: Effect.fn("AzureDevOpsService.verifyProject")(
      function* (repository) {
        const identity = splitAzureDevOpsProjectPath(repository.projectPath)
        if (identity === null) {
          return yield* invalidProjectPath(repository)
        }
        const value = yield* unavailableOn404(
          repository,
          requestUnknown(
            identity.organization,
            `/_apis/projects/${encodeURIComponent(identity.project)}`,
            `Failed to verify Azure DevOps project ${repository.projectPath}`,
          ),
        )
        const project = yield* Effect.try({
          try: () => decode(ProjectSchema, value),
          catch: (cause) =>
            requestError("Azure DevOps returned an invalid project", cause),
        })
        return {
          forge: repository.forge,
          forgeHost: repository.forgeHost,
          projectPath: `${identity.organization}/${project.name}`,
        } satisfies AzureDevOpsRepository
      },
    ),
    getAuthenticatedUserLogin: Effect.fn(
      "AzureDevOpsService.getAuthenticatedUserLogin",
    )(function* (repository) {
      const identity = splitAzureDevOpsProjectPath(repository.projectPath)
      if (identity === null) {
        return yield* invalidProjectPath(repository)
      }
      const value = yield* unavailableOn404(
        repository,
        requestUnknown(
          identity.organization,
          "/_apis/connectionData",
          `Failed to resolve authenticated Azure DevOps user for ${identity.organization}`,
        ),
      )
      const connectionData = yield* Effect.try({
        try: () => decode(ConnectionDataSchema, value),
        catch: (cause) =>
          requestError("Azure DevOps returned invalid connection data", cause),
      })
      const displayName = connectionData.authenticatedUser.providerDisplayName
      if (typeof displayName === "string" && displayName.trim() !== "") {
        return displayName
      }
      const id = connectionData.authenticatedUser.id
      if (typeof id === "string" && id.trim() !== "") {
        return id
      }
      return yield* requestError(
        "Azure DevOps did not return an authenticated user identity",
        connectionData,
      )
    }),
    listReadyIssues: () => notImplemented("listReadyIssues"),
    hasCredentials: () => Effect.succeed(options.token !== undefined),
    hasAmbientCredentials: () => Effect.succeed(options.token !== undefined),
    getOpenPullRequestNumber: () => notImplemented("getOpenPullRequestNumber"),
    findOpenPullRequestNumber: () =>
      notImplemented("findOpenPullRequestNumber"),
    createDraftPullRequest: () => notImplemented("createDraftPullRequest"),
    updateOpenDraftPullRequestCopy: () =>
      notImplemented("updateOpenDraftPullRequestCopy"),
    countOpenNonDraftPullRequests: () =>
      notImplemented("countOpenNonDraftPullRequests"),
    getPullRequestCheckStatus: () =>
      notImplemented("getPullRequestCheckStatus"),
    getPrStatusCheckDiagnostics: () =>
      notImplemented("getPrStatusCheckDiagnostics"),
    markPullRequestReadyForReview: () =>
      notImplemented("markPullRequestReadyForReview"),
    getPullRequestLifecycleStatus: () =>
      notImplemented("getPullRequestLifecycleStatus"),
    mergePullRequest: () => notImplemented("mergePullRequest"),
    ensureIssueCompletedWithSummary: () =>
      notImplemented("ensureIssueCompletedWithSummary"),
    closeOpenPullRequestsForBranch: () =>
      notImplemented("closeOpenPullRequestsForBranch"),
    deleteBranch: () => notImplemented("deleteBranch"),
  } satisfies AzureDevOpsServiceShape
}

export const makeAzureDevOpsServiceFromToken = (
  token: string,
  fetchImpl: AzureDevOpsFetch = fetch,
): AzureDevOpsServiceShape =>
  makeAzureDevOpsService({ token, fetch: fetchImpl })

/**
 * Helper-process Live layer: reads `AZURE_DEVOPS_EXT_PAT` from the
 * environment. Keymaxxer injects the named vault secret aliased as
 * `AZURE_DEVOPS_EXT_PAT` so the raw token never enters the Harness process.
 */
export const AzureDevOpsServiceLive = Layer.effect(
  AzureDevOpsService,
  Effect.gen(function* () {
    const token = yield* Config.redacted(AZURE_DEVOPS_PAT_ENV_VAR)
    return makeAzureDevOpsServiceFromToken(Redacted.value(token))
  }),
)
