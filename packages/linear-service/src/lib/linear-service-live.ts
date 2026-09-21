import { Config, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { extractErrorCode } from "@ready-for-agent/forge-contract"
import { LinearRequestError } from "./errors.js"
import {
  LinearService,
  type LinearServiceError,
  type LinearServiceShape,
} from "./linear-service.js"
import {
  LINEAR_API_KEY_ENV_VAR,
  LINEAR_API_URL,
  LINEAR_READY_LABEL,
  type LinearProject,
  type LinearReadyLabeledIssue,
  type LinearTeamWorkflow,
  type LinearWorkflowState,
  isLinearOpenStateType,
  suggestDoneState,
  suggestInProgressState,
  unreadableLinearBlockerNativeId,
  unreadableLinearBlockerUrl,
} from "./types.js"

const REQUEST_TIMEOUT = Duration.seconds(30)
const PAGE_SIZE = 50

type LinearFetch = typeof fetch

class LinearHttpError extends Error {
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
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const PageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
})
const ViewerSchema = Schema.Struct({
  viewer: Schema.Struct({
    id: RequiredString,
  }),
})
const ProjectNodeSchema = Schema.Struct({
  id: RequiredString,
  name: RequiredString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
})
const ProjectsSchema = Schema.Struct({
  projects: Schema.Struct({
    nodes: Schema.Array(ProjectNodeSchema),
    pageInfo: Schema.optional(PageInfoSchema),
  }),
})
const WorkflowStateNodeSchema = Schema.Struct({
  id: RequiredString,
  name: RequiredString,
  type: RequiredString,
  position: Schema.optional(Schema.Number),
})
const TeamNodeSchema = Schema.Struct({
  id: RequiredString,
  key: RequiredString,
  name: RequiredString,
  states: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(WorkflowStateNodeSchema),
    }),
  ),
})
const ProjectWorkflowSchema = Schema.Struct({
  project: Schema.NullOr(
    Schema.Struct({
      id: RequiredString,
      name: RequiredString,
      teams: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(TeamNodeSchema),
        }),
      ),
    }),
  ),
})
const LabelNodeSchema = Schema.Struct({
  name: RequiredString,
})
const IssueStateSchema = Schema.Struct({
  type: RequiredString,
})
const RelatedIssueSchema = Schema.Struct({
  id: RequiredString,
  identifier: RequiredString,
  number: PositiveInt,
  url: RequiredString,
  state: Schema.optional(IssueStateSchema),
})
const RelationNodeSchema = Schema.Struct({
  id: RequiredString,
  type: RequiredString,
  issue: Schema.optional(Schema.NullOr(RelatedIssueSchema)),
})
const ParentIssueSchema = Schema.Struct({
  id: RequiredString,
  identifier: RequiredString,
  number: PositiveInt,
  url: RequiredString,
  state: Schema.optional(IssueStateSchema),
  labels: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(LabelNodeSchema),
    }),
  ),
})
const IssueNodeSchema = Schema.Struct({
  id: RequiredString,
  identifier: RequiredString,
  number: PositiveInt,
  title: RequiredString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: RequiredString,
  createdAt: RequiredString,
  creator: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: RequiredString,
      }),
    ),
  ),
  parent: Schema.optional(Schema.NullOr(ParentIssueSchema)),
  children: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ id: RequiredString })),
    }),
  ),
  inverseRelations: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(RelationNodeSchema),
    }),
  ),
})
const IssuesSchema = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(IssueNodeSchema),
    pageInfo: Schema.optional(PageInfoSchema),
  }),
})
const GraphqlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  path: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  ),
  extensions: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
    }),
  ),
})
const GraphqlEnvelopeSchema = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(GraphqlErrorSchema)),
})

const VIEWER_QUERY = `query Viewer {
  viewer { id }
}`

const PROJECTS_QUERY = `query Projects($after: String) {
  projects(
    first: ${PAGE_SIZE}
    after: $after
    filter: { status: { type: { nin: ["canceled"] } } }
  ) {
    nodes { id name url }
    pageInfo { hasNextPage endCursor }
  }
}`

const PROJECT_WORKFLOW_QUERY = `query ProjectWorkflow($id: String!) {
  project(id: $id) {
    id
    name
    teams(first: ${PAGE_SIZE}) {
      nodes {
        id
        key
        name
        states(first: ${PAGE_SIZE}) {
          nodes { id name type position }
        }
      }
    }
  }
}`

const READY_ISSUES_QUERY = `query ReadyIssues($projectId: ID!, $after: String) {
  issues(
    first: ${PAGE_SIZE}
    after: $after
    filter: {
      project: { id: { eq: $projectId } }
      labels: { name: { eq: "${LINEAR_READY_LABEL}" } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes {
      id
      identifier
      number
      title
      description
      url
      createdAt
      creator { id }
      parent {
        id
        identifier
        number
        url
        state { type }
        labels { nodes { name } }
      }
      children(first: 1) { nodes { id } }
      inverseRelations(first: 50) {
        nodes {
          id
          type
          issue {
            id
            identifier
            number
            url
            state { type }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

const decode = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value)

const requestError = (
  message: string,
  cause?: unknown,
  statusCode?: number,
): LinearRequestError =>
  new LinearRequestError({
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(extractErrorCode(cause) === undefined
      ? {}
      : { code: extractErrorCode(cause) }),
  })

const hasUsableGraphqlData = (data: unknown): boolean =>
  data !== null && data !== undefined && typeof data === "object"

const isNestedGraphqlFieldError = (error: {
  readonly path?: ReadonlyArray<string | number>
}): boolean => (error.path?.length ?? 0) >= 2

const authenticationError = (statusCode?: number) =>
  new LinearRequestError({
    message:
      "Linear API key is invalid or expired. Create a new personal API key and store it in Keymaxxer.",
    ...(statusCode === undefined ? {} : { statusCode }),
    code: "AUTHENTICATION_ERROR",
  })

const missingKeyError = () =>
  new LinearRequestError({
    message:
      "Linear API key is not configured. Store a personal API key in Keymaxxer, then try again.",
    code: "NOT_CONFIGURED",
  })

const toLinearState = (type: string | undefined): "OPEN" | "CLOSED" =>
  type !== undefined && isLinearOpenStateType(type) ? "OPEN" : "CLOSED"

const isReadyLabeled = (
  labels: readonly { readonly name: string }[] | undefined,
): boolean =>
  (labels ?? []).some(
    (label) => label.name.toLowerCase() === LINEAR_READY_LABEL,
  )

const toReadyLabeledIssue = (
  node: typeof IssueNodeSchema.Type,
): LinearReadyLabeledIssue => {
  const createdAt = new Date(node.createdAt)
  const blockedBy = (node.inverseRelations?.nodes ?? [])
    .filter((relation) => relation.type === "blocks")
    .map((relation) => {
      const blocker = relation.issue
      if (blocker === null || blocker === undefined) {
        return {
          number: 1,
          url: unreadableLinearBlockerUrl(relation.id),
          nativeId: unreadableLinearBlockerNativeId(relation.id),
          displayId: "unreadable",
        }
      }
      if (
        blocker.state !== undefined &&
        !isLinearOpenStateType(blocker.state.type)
      ) {
        return null
      }
      return {
        number: blocker.number,
        url: blocker.url,
        nativeId: blocker.id,
        displayId: blocker.identifier,
      }
    })
    .filter((dependency) => dependency !== null)
  const parent = node.parent ?? null
  return {
    number: node.number,
    nativeId: node.id,
    displayId: node.identifier,
    title: node.title,
    body: node.description ?? "",
    url: node.url,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(0) : createdAt,
    state: "OPEN",
    author: node.creator?.id ?? null,
    parent:
      parent === null
        ? null
        : {
            number: parent.number,
            url: parent.url,
            nativeId: parent.id,
            displayId: parent.identifier,
            state: toLinearState(parent.state?.type),
            isReadyLabeled: isReadyLabeled(parent.labels?.nodes),
          },
    parentPosition: null,
    hasChildren: (node.children?.nodes.length ?? 0) > 0,
    hierarchySupported: true,
    blockedBy,
    closingPullRequests: [],
  }
}

const toTeamWorkflow = (
  team: typeof TeamNodeSchema.Type,
): LinearTeamWorkflow => {
  const states: LinearWorkflowState[] = (team.states?.nodes ?? []).map(
    (state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position ?? 0,
    }),
  )
  return {
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    states,
    suggestedInProgressStateId: suggestInProgressState(states)?.id ?? null,
    suggestedDoneStateId: suggestDoneState(states)?.id ?? null,
  }
}

export const makeLinearService = (options: {
  readonly token?: string
  readonly fetch?: LinearFetch
}): LinearServiceShape => {
  const fetchImpl = options.fetch ?? fetch
  const token = options.token?.trim() ?? ""
  const configured = token.length > 0

  const graphql = <S extends { readonly Type: unknown }>(input: {
    readonly query: string
    readonly variables?: Record<string, unknown>
    readonly schema: S & Parameters<typeof Schema.decodeUnknownSync>[0]
    readonly describe: string
  }): Effect.Effect<S["Type"], LinearServiceError> =>
    Effect.gen(function* () {
      if (!configured) {
        return yield* missingKeyError()
      }
      const payload = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(LINEAR_API_URL, {
            method: "POST",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: input.query,
              ...(input.variables === undefined
                ? {}
                : { variables: input.variables }),
            }),
            signal,
          })
          const body: unknown = await response.json().catch(() => null)
          if (response.status === 401 || response.status === 403) {
            throw new LinearHttpError(response.status, "unauthorized")
          }
          if (!response.ok) {
            throw new LinearHttpError(
              response.status,
              `Linear returned HTTP ${response.status} while ${input.describe}`,
            )
          }
          return body
        },
        catch: (cause) => {
          if (cause instanceof LinearHttpError) {
            if (cause.statusCode === 401 || cause.statusCode === 403) {
              return authenticationError(cause.statusCode)
            }
            return requestError(cause.message, cause, cause.statusCode)
          }
          return requestError(`Failed to ${input.describe}`, cause)
        },
      }).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(requestError(`Timed out while ${input.describe}`, cause)),
        ),
      )

      const envelope = yield* Effect.try({
        try: () => decode(GraphqlEnvelopeSchema, payload),
        catch: (cause) =>
          requestError(`Linear returned an invalid GraphQL envelope`, cause),
      })
      const graphqlErrors = envelope.errors ?? []
      const graphqlError = graphqlErrors[0]
      const graphqlCode = graphqlError?.extensions?.code
      if (
        graphqlCode === "AUTHENTICATION_ERROR" ||
        graphqlCode === "UNAUTHENTICATED"
      ) {
        return yield* authenticationError()
      }
      // Linear returns HTTP 200 with data plus nested field errors when a
      // related Issue is unreadable; aborting would drop blockers instead of
      // keeping them.
      const nestedFieldErrorsOnly =
        hasUsableGraphqlData(envelope.data) &&
        graphqlErrors.length > 0 &&
        graphqlErrors.every(isNestedGraphqlFieldError)
      if (graphqlError !== undefined && !nestedFieldErrorsOnly) {
        return yield* requestError(
          graphqlError.message?.trim() ||
            `Linear GraphQL error while ${input.describe}`,
          graphqlError,
        )
      }
      return yield* Effect.try({
        try: () => decode(input.schema, envelope.data ?? {}),
        catch: (cause) =>
          requestError(
            `Linear returned invalid data while ${input.describe}`,
            cause,
          ),
      })
    })

  return {
    getAuthenticatedUserLogin: Effect.fn(
      "LinearService.getAuthenticatedUserLogin",
    )(function* () {
      const data = yield* graphql({
        query: VIEWER_QUERY,
        schema: ViewerSchema,
        describe: "reading the Linear viewer",
      })
      return data.viewer.id
    }),
    listProjects: Effect.fn("LinearService.listProjects")(function* () {
      const projects: LinearProject[] = []
      let after: string | undefined
      for (;;) {
        const data = yield* graphql({
          query: PROJECTS_QUERY,
          variables: { after: after ?? null },
          schema: ProjectsSchema,
          describe: "listing Linear projects",
        })
        for (const node of data.projects.nodes) {
          projects.push({
            id: node.id,
            name: node.name,
            url: node.url ?? null,
          })
        }
        if (
          data.projects.pageInfo?.hasNextPage !== true ||
          data.projects.pageInfo.endCursor === null ||
          data.projects.pageInfo.endCursor === undefined
        ) {
          break
        }
        after = data.projects.pageInfo.endCursor
      }
      return projects.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      )
    }),
    listProjectWorkflow: Effect.fn("LinearService.listProjectWorkflow")(
      function* (projectId: string) {
        const data = yield* graphql({
          query: PROJECT_WORKFLOW_QUERY,
          variables: { id: projectId },
          schema: ProjectWorkflowSchema,
          describe: `listing Linear workflow states for project ${projectId}`,
        })
        if (data.project === null) {
          return yield* requestError(
            `Linear project ${projectId} was not found. Choose a project you can access.`,
          )
        }
        return (data.project.teams?.nodes ?? []).map(toTeamWorkflow)
      },
    ),
    listReadyIssues: Effect.fn("LinearService.listReadyIssues")(function* (
      projectId: string,
    ) {
      const issues: LinearReadyLabeledIssue[] = []
      let after: string | undefined
      for (;;) {
        const data = yield* graphql({
          query: READY_ISSUES_QUERY,
          variables: { projectId, after: after ?? null },
          schema: IssuesSchema,
          describe: `listing Ready-labeled Linear Issues in project ${projectId}`,
        })
        for (const node of data.issues.nodes) {
          issues.push(toReadyLabeledIssue(node))
        }
        if (
          data.issues.pageInfo?.hasNextPage !== true ||
          data.issues.pageInfo.endCursor === null ||
          data.issues.pageInfo.endCursor === undefined
        ) {
          break
        }
        after = data.issues.pageInfo.endCursor
      }
      return issues.sort((left, right) =>
        (left.displayId ?? String(left.number)).localeCompare(
          right.displayId ?? String(right.number),
          undefined,
          { numeric: true },
        ),
      )
    }),
    hasCredentials: () => Effect.succeed(configured),
    hasAmbientCredentials: () => Effect.succeed(configured),
  } satisfies LinearServiceShape
}

export const makeLinearServiceFromToken = (
  token: string,
  fetchImpl: LinearFetch = fetch,
): LinearServiceShape => makeLinearService({ token, fetch: fetchImpl })

export const makeAnonymousLinearService = (
  fetchImpl: LinearFetch = fetch,
): LinearServiceShape => makeLinearService({ fetch: fetchImpl })

/**
 * Helper-process Live layer: reads `LINEAR_API_KEY` from the environment.
 * Keymaxxer injects the named vault secret aliased as `LINEAR_API_KEY`
 * so the raw token never enters the Harness process.
 */
export const LinearServiceLive = Layer.effect(
  LinearService,
  Effect.gen(function* () {
    const token = yield* Config.redacted(LINEAR_API_KEY_ENV_VAR)
    return makeLinearServiceFromToken(Redacted.value(token))
  }),
)
