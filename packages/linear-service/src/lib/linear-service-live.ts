import { Config, Duration, Effect, Layer, Redacted, Schema } from "effect"
import {
  SPEC_LABEL,
  extractErrorCode,
  resolveSpecBaseline,
} from "@ready-for-agent/forge-contract"
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
  type LinearIssueSnapshot,
  type LinearProject,
  type LinearReadyLabeledIssue,
  type LinearSpecObservation,
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
const SPEC_CHILDREN_BATCH_SIZE = 8

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
const SpecLabelsSchema = Schema.Struct({ nodes: Schema.Array(LabelNodeSchema) })
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
  specLabels: Schema.optional(SpecLabelsSchema),
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
const StrictPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(RequiredString),
})
const HierarchyNodeSchema = Schema.Struct({
  id: RequiredString,
  state: IssueStateSchema,
})
const SpecIssuesSchema = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        ...HierarchyNodeSchema.fields,
        identifier: RequiredString,
        url: RequiredString,
      }),
    ),
    pageInfo: StrictPageInfoSchema,
  }),
})
const SpecChildrenSchema = Schema.Record(
  Schema.String,
  Schema.NullOr(
    Schema.Struct({
      id: RequiredString,
      children: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            ...HierarchyNodeSchema.fields,
            children: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ id: RequiredString })),
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
            }),
          }),
        ),
        pageInfo: StrictPageInfoSchema,
      }),
    }),
  ),
)
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

const SPEC_LABELS_SELECTION = `specLabels: labels(first: 1, filter: { name: { eq: "${SPEC_LABEL}" } }) {
  nodes { name }
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
      ${SPEC_LABELS_SELECTION}
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

const OPEN_SPECS_QUERY = `query OpenSpecs($projectId: ID!, $after: String) {
  issues(
    first: ${PAGE_SIZE}
    after: $after
    includeArchived: true
    filter: {
      project: { id: { eq: $projectId } }
      labels: { name: { eq: "spec" } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes { id identifier url state { type } }
    pageInfo { hasNextPage endCursor }
  }
}`

const specChildrenSelection = (afterVariable: string) => `{
    id
    children(first: ${PAGE_SIZE}, after: $${afterVariable}, includeArchived: true) {
      nodes {
        id
        state { type }
        children(first: 1, includeArchived: true) {
          nodes { id }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`

const SPEC_QUERY = `query Spec($id: String!) {
  issue(id: $id) {
    title
    description
    url
    ${SPEC_LABELS_SELECTION}
  }
}`

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
    team { id key }
    state { id name type }
  }
}`

const ISSUE_COMMENTS_QUERY = `query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: ${PAGE_SIZE}, after: $after) {
      nodes { id body url editedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id state { id type } }
  }
}`

const COMMENT_CREATE_MUTATION = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id body }
  }
}`

const COMMENT_UPDATE_MUTATION = `mutation CommentUpdate($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment { id body }
  }
}`

const IssueSnapshotNodeSchema = Schema.Struct({
  id: RequiredString,
  identifier: RequiredString,
  url: RequiredString,
  team: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: RequiredString,
        key: RequiredString,
      }),
    ),
  ),
  state: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: RequiredString,
        name: RequiredString,
        type: RequiredString,
      }),
    ),
  ),
})
const IssueSnapshotSchema = Schema.Struct({
  issue: Schema.NullOr(IssueSnapshotNodeSchema),
})
const CommentNodeSchema = Schema.Struct({
  id: RequiredString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
})
const IssueCommentsSchema = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      id: RequiredString,
      comments: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(CommentNodeSchema),
          pageInfo: Schema.optional(PageInfoSchema),
        }),
      ),
    }),
  ),
})
const SpecSchema = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      title: RequiredString,
      description: Schema.NullOr(Schema.String),
      url: RequiredString,
      specLabels: SpecLabelsSchema,
    }),
  ),
})
const SpecCommentsSchema = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      comments: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            body: Schema.String,
            url: RequiredString,
            editedAt: Schema.NullOr(Schema.String),
          }),
        ),
        pageInfo: Schema.Struct({
          hasNextPage: Schema.Boolean,
          endCursor: Schema.NullOr(Schema.String),
        }),
      }),
    }),
  ),
})
const IssueUpdateSchema = Schema.Struct({
  issueUpdate: Schema.Struct({
    success: Schema.optional(Schema.Boolean),
    issue: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: RequiredString,
        }),
      ),
    ),
  }),
})
const CommentCreateSchema = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.optional(Schema.Boolean),
    comment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: RequiredString,
          body: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
})
const CommentUpdateSchema = Schema.Struct({
  commentUpdate: Schema.Struct({
    success: Schema.optional(Schema.Boolean),
    comment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: RequiredString,
          body: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
})

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

interface HierarchyPage<A> {
  readonly nodes: readonly A[]
  readonly pageInfo: typeof StrictPageInfoSchema.Type
}

interface SpecChildPageRequest {
  readonly id: string
  readonly after: string | null
  readonly seenCursors: Set<string>
}

const nextHierarchyCursor = (input: {
  readonly page: HierarchyPage<unknown>
  readonly after: string | null
  readonly seenCursors: Set<string>
  readonly describe: string
}): Effect.Effect<string | null, LinearServiceError> => {
  const { page, after, seenCursors, describe } = input
  const { hasNextPage, endCursor } = page.pageInfo
  if (page.nodes.length === 0 && (after !== null || hasNextPage)) {
    return Effect.fail(
      requestError(`Linear returned an empty continuation while ${describe}`),
    )
  }
  if (!hasNextPage) return Effect.succeed(null)
  if (endCursor === null || seenCursors.has(endCursor)) {
    return Effect.fail(
      requestError(`Linear returned incomplete pagination while ${describe}`),
    )
  }
  seenCursors.add(endCursor)
  return Effect.succeed(endCursor)
}

// Unlike intake, absence of pagination metadata cannot mean end of data.
const readHierarchyPages = Effect.fn("LinearService.readHierarchyPages")(
  function* <A extends { readonly id: string }>(
    describe: string,
    load: (
      after: string | null,
    ) => Effect.Effect<HierarchyPage<A>, LinearServiceError>,
  ) {
    const nodes = new Map<string, A>()
    const cursors = new Set<string>()
    let after: string | null = null
    for (;;) {
      const page: HierarchyPage<A> = yield* load(after)
      for (const node of page.nodes) {
        if (nodes.has(node.id)) {
          return yield* requestError(
            `Linear returned a duplicate Issue while ${describe}`,
          )
        }
        nodes.set(node.id, node)
      }
      const next: string | null = yield* nextHierarchyCursor({
        page,
        after,
        seenCursors: cursors,
        describe,
      })
      if (next === null) {
        return [...nodes.values()]
      }
      after = next
    }
  },
)

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

const isSpecLabeled = (labels: typeof SpecLabelsSchema.Type | undefined) =>
  labels?.nodes.some((label) => label.name === SPEC_LABEL) ?? false

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
    readonly requireCompleteData?: boolean
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
      if (
        graphqlError !== undefined &&
        (input.requireCompleteData || !nestedFieldErrorsOnly)
      ) {
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

  const observeDescendants = Effect.fn("LinearService.observeSpecDescendants")(
    function* (specId: string) {
      const seen = new Set([specId])
      const firstPage = (id: string): SpecChildPageRequest => ({
        id,
        after: null,
        seenCursors: new Set<string>(),
      })
      const pending = [firstPage(specId)]
      let hasOpenDescendant = false
      for (let offset = 0; offset < pending.length; ) {
        // Each alias keeps its own cursor; bounding the batch also bounds
        // the number of child pages requested in one GraphQL operation.
        const batch = pending.slice(offset, offset + SPEC_CHILDREN_BATCH_SIZE)
        offset += batch.length
        const variables: Record<string, unknown> = {}
        const declarations: string[] = []
        const fields = batch.map((request, index) => {
          const suffix = index === 0 ? "" : String(index)
          const idVariable = `id${suffix}`
          const afterVariable = `after${suffix}`
          variables[idVariable] = request.id
          variables[afterVariable] = request.after
          declarations.push(
            `$${idVariable}: String!, $${afterVariable}: String`,
          )
          const key = `issue${suffix}`
          return {
            ...request,
            key,
            selection: `${key}: issue(id: $${idVariable}) ${specChildrenSelection(afterVariable)}`,
          }
        })
        const data = yield* graphql({
          query: `query SpecChildren(${declarations.join(", ")}) {
            ${fields.map(({ selection }) => selection).join("\n")}
          }`,
          variables,
          schema: SpecChildrenSchema,
          describe: `reading descendants of Linear Spec ${specId}`,
          requireCompleteData: true,
        })
        for (const { id, after, seenCursors, key } of fields) {
          const issue = data[key]
          if (issue?.id !== id) {
            return yield* requestError(`Linear Issue ${id} could not be read`)
          }
          const next = yield* nextHierarchyCursor({
            page: issue.children,
            after,
            seenCursors,
            describe: `reading children of Linear Issue ${id}`,
          })
          if (next !== null) {
            pending.push({ id, after: next, seenCursors })
          }
          for (const child of issue.children.nodes) {
            if (seen.has(child.id)) {
              return yield* requestError(
                `Linear returned a duplicate descendant of Spec ${specId}`,
              )
            }
            seen.add(child.id)
            // Prove leaves with the nested connection instead of querying each
            // one separately. Branches still get a complete paginated read.
            if (child.children.nodes.length > 0) {
              pending.push(firstPage(child.id))
            } else if (child.children.pageInfo.hasNextPage) {
              return yield* requestError(
                `Linear returned incomplete child data for Issue ${child.id}`,
              )
            }
            if (isLinearOpenStateType(child.state.type)) {
              hasOpenDescendant = true
            }
          }
        }
      }
      return hasOpenDescendant || seen.size === 1
        ? "waiting"
        : "all-descendants-closed"
    },
  )

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
          const issue = toReadyLabeledIssue(node)
          if (issue.hasChildren || !isSpecLabeled(node.specLabels)) {
            issues.push(issue)
          }
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
        left.displayId.localeCompare(right.displayId, undefined, {
          numeric: true,
        }),
      )
    }),
    observeSpecs: Effect.fn("LinearService.observeSpecs")(function* (
      projectId: string,
    ) {
      const describe = `listing open Linear Specs in project ${projectId}`
      const specs = yield* readHierarchyPages(describe, (after) =>
        graphql({
          query: OPEN_SPECS_QUERY,
          variables: { projectId, after },
          schema: SpecIssuesSchema,
          describe,
          requireCompleteData: true,
        }).pipe(Effect.map(({ issues }) => issues)),
      )
      const observations: LinearSpecObservation[] = []
      for (const spec of specs) {
        if (!isLinearOpenStateType(spec.state.type)) {
          continue
        }
        const readiness = yield* observeDescendants(spec.id).pipe(
          Effect.catch(() => Effect.succeed("hierarchy-unavailable" as const)),
        )
        observations.push({
          nativeId: spec.id,
          displayId: spec.identifier,
          url: spec.url,
          readiness,
        })
      }
      return observations
    }),
    readSpecBaseline: Effect.fn("LinearService.readSpecBaseline")(
      function* (nativeId) {
        const { issue } = yield* graphql({
          query: SPEC_QUERY,
          variables: { id: nativeId },
          schema: SpecSchema,
          describe: `reading Linear Spec ${nativeId}`,
        })
        if (!issue)
          return yield* requestError(`Linear Issue ${nativeId} not found`)
        if (!isSpecLabeled(issue.specLabels)) return { kind: "not-spec" }

        const comments: { body: string; url: string; edited: boolean }[] = []
        let after: string | null = null
        const seen = new Set<string>()
        for (;;) {
          const page: typeof SpecCommentsSchema.Type = yield* graphql({
            query: ISSUE_COMMENTS_QUERY,
            variables: { id: nativeId, after },
            schema: SpecCommentsSchema,
            describe: `reading comments for Linear Spec ${nativeId}`,
          })
          if (!page.issue) {
            return yield* requestError(`Linear Issue ${nativeId} not found`)
          }
          const { nodes, pageInfo } = page.issue.comments
          for (const comment of nodes) {
            comments.push({
              body: comment.body,
              url: comment.url,
              edited: comment.editedAt !== null,
            })
          }
          if (!pageInfo.hasNextPage) {
            return resolveSpecBaseline(
              { ...issue, body: issue.description ?? "", marked: true },
              comments,
            )
          }
          after = pageInfo.endCursor
          if (!after || seen.has(after)) {
            return yield* requestError(
              `Linear returned an invalid comments page cursor for Spec ${nativeId}`,
            )
          }
          seen.add(after)
        }
      },
    ),
    getIssue: Effect.fn("LinearService.getIssue")(function* (nativeId: string) {
      const data = yield* graphql({
        query: ISSUE_QUERY,
        variables: { id: nativeId },
        schema: IssueSnapshotSchema,
        describe: `reading Linear Issue ${nativeId}`,
      })
      const issue = data.issue
      if (issue === null) {
        return yield* requestError(
          `Linear Issue ${nativeId} was not found. Confirm the Issue still exists and the API key can read it.`,
        )
      }
      const team = issue.team
      const state = issue.state
      if (team === null || team === undefined) {
        return yield* requestError(
          `Linear Issue ${issue.identifier} has no team. Choose an Issue on a team with In Progress and Done statuses configured.`,
        )
      }
      if (state === null || state === undefined) {
        return yield* requestError(
          `Linear Issue ${issue.identifier} has no workflow state.`,
        )
      }
      return {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        teamId: team.id,
        teamKey: team.key,
        stateId: state.id,
        stateName: state.name,
        stateType: state.type,
      } satisfies LinearIssueSnapshot
    }),
    updateIssueState: Effect.fn("LinearService.updateIssueState")(function* (
      nativeId: string,
      stateId: string,
    ) {
      const current = yield* graphql({
        query: ISSUE_QUERY,
        variables: { id: nativeId },
        schema: IssueSnapshotSchema,
        describe: `reading Linear Issue ${nativeId} before a workflow update`,
      })
      if (current.issue === null) {
        return yield* requestError(
          `Linear Issue ${nativeId} was not found. Confirm the Issue still exists and the API key can update it.`,
        )
      }
      const currentState = current.issue.state
      if (currentState?.id === stateId) {
        return
      }
      if (
        currentState !== null &&
        currentState !== undefined &&
        !isLinearOpenStateType(currentState.type)
      ) {
        return
      }
      const updated = yield* graphql({
        query: ISSUE_UPDATE_MUTATION,
        variables: { id: nativeId, stateId },
        schema: IssueUpdateSchema,
        describe: `updating Linear Issue ${nativeId} workflow state`,
      })
      if (updated.issueUpdate.success === false) {
        return yield* requestError(
          `Linear did not update Issue ${current.issue.identifier} to the configured workflow status.`,
        )
      }
    }),
    ensureMilestoneComment: Effect.fn("LinearService.ensureMilestoneComment")(
      function* (nativeId: string, marker: string, body: string) {
        if (marker.trim() === "" || body.trim() === "") {
          return yield* requestError(
            `Linear milestone comment for Issue ${nativeId} was empty.`,
          )
        }
        let existingId: string | null = null
        let existingBody: string | null = null
        let after: string | undefined
        for (;;) {
          const data = yield* graphql({
            query: ISSUE_COMMENTS_QUERY,
            variables: { id: nativeId, after: after ?? null },
            schema: IssueCommentsSchema,
            describe: `listing comments for Linear Issue ${nativeId}`,
          })
          if (data.issue === null) {
            return yield* requestError(
              `Linear Issue ${nativeId} was not found. Confirm the Issue still exists and the API key can comment on it.`,
            )
          }
          for (const comment of data.issue.comments?.nodes ?? []) {
            const commentBody = comment.body ?? ""
            if (commentBody.includes(marker)) {
              existingId = comment.id
              existingBody = commentBody
              break
            }
          }
          if (existingId !== null) {
            break
          }
          const pageInfo = data.issue.comments?.pageInfo
          if (
            pageInfo?.hasNextPage !== true ||
            pageInfo.endCursor === null ||
            pageInfo.endCursor === undefined
          ) {
            break
          }
          after = pageInfo.endCursor
        }

        if (existingId !== null) {
          if (existingBody === body) {
            return
          }
          const updated = yield* graphql({
            query: COMMENT_UPDATE_MUTATION,
            variables: { id: existingId, body },
            schema: CommentUpdateSchema,
            describe: `updating a Linear milestone comment on Issue ${nativeId}`,
          })
          if (updated.commentUpdate.success === false) {
            return yield* requestError(
              `Linear did not update the existing milestone comment on Issue ${nativeId}.`,
            )
          }
          return
        }

        const created = yield* graphql({
          query: COMMENT_CREATE_MUTATION,
          variables: { issueId: nativeId, body },
          schema: CommentCreateSchema,
          describe: `posting a Linear milestone comment on Issue ${nativeId}`,
        })
        if (created.commentCreate.success === false) {
          return yield* requestError(
            `Linear did not create a milestone comment on Issue ${nativeId}.`,
          )
        }
        const posted = created.commentCreate.comment?.body ?? ""
        if (!posted.includes(marker)) {
          return yield* requestError(
            `Linear did not return the marked milestone comment on Issue ${nativeId}.`,
          )
        }
      },
    ),
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
    const token = yield* Config.Redacted(LINEAR_API_KEY_ENV_VAR)
    return makeLinearServiceFromToken(Redacted.value(token))
  }),
)
