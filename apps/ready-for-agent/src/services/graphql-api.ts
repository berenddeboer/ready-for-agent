import { Context, Effect, Layer, Runtime, Schema } from "effect"
import { createClient } from "@ready-for-agent/graphql-client"
import {
  type CanonicalRepositoryIdentity,
  type IntakeCandidateAction,
  type IntakeIssueResult,
  type StatusLane,
  type StatusLaneId,
  type StatusWorkItemRow,
  toCanonicalRepositoryIdentity,
} from "../cli-json.ts"
import type { LocalRepository, RepositorySummary } from "../domain.ts"
import {
  GraphqlUrlNotEndpointError,
  describeGraphqlFailure,
} from "../graphql-error.ts"
import { ApplicationConfig } from "./application-config.ts"

const jsonMediaType = (contentType: string | null): string | undefined => {
  if (contentType === null) {
    return undefined
  }
  return contentType.split(";")[0]?.trim().toLowerCase()
}

const isJsonContentType = (contentType: string | null): boolean => {
  const mediaType = jsonMediaType(contentType)
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  )
}

/** Reject HTML (and other non-JSON) before genql parses the response body. */
const createGraphqlEndpointFetch =
  (configuredUrl: string) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init)
    if (!isJsonContentType(response.headers.get("content-type"))) {
      throw new GraphqlUrlNotEndpointError(configuredUrl)
    }
    return response
  }

/**
 * Expected GraphQL operator failures. Marked as already reported so
 * `BunRuntime.runMain` does not pretty-print a multi-frame stack after the
 * CLI writes the versioned JSON error once (harness-down and similar).
 * `code` is the Harness `extensions.code` or a CLI-owned transport code.
 */
export class GraphqlRequestFailed extends Schema.TaggedErrorClass<GraphqlRequestFailed>()(
  "GraphqlRequestFailed",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false
}

export type ConfiguredRepository = {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type IntakeCandidatesResult = {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
    readonly issuesReconciledAt: string | null
  }
  readonly candidates: readonly {
    readonly issueNumber: number
    readonly title: string
    readonly url: string
    readonly action: IntakeCandidateAction
  }[]
}

export type RepositoryIntakeResult = {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
    readonly issuesReconciledAt: string | null
  }
  readonly results: readonly IntakeIssueResult[]
}

export type KanbanStatusResult = {
  readonly repository: CanonicalRepositoryIdentity | null
  readonly lanes: readonly StatusLane[]
}

const isStatusLaneId = (value: string): value is StatusLaneId => {
  switch (value) {
    case "QUEUE":
    case "BUILD":
    case "REVIEW":
    case "PR":
    case "ATTENTION":
    case "MERGED":
      return true
    default:
      return false
  }
}

const toStatusWorkItemRow = (row: {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
  }
  readonly workItem: {
    readonly id: string
    readonly issueNumber: number
    readonly issueTitle: string | null
    readonly state: string
    readonly status: string
    readonly statusMessage: string | null
    readonly paused: boolean
    readonly pullRequestNumber: number | null
    readonly createdAt: string
    readonly updatedAt: string
    readonly stateReadyAt: string
    readonly postponedUntil: string | null
  }
}): StatusWorkItemRow => ({
  repository: toCanonicalRepositoryIdentity(row.repository),
  id: row.workItem.id,
  issueNumber: row.workItem.issueNumber,
  issueTitle: row.workItem.issueTitle,
  state: row.workItem.state,
  status: row.workItem.status,
  statusMessage: row.workItem.statusMessage,
  paused: row.workItem.paused,
  pullRequestNumber: row.workItem.pullRequestNumber,
  createdAt: row.workItem.createdAt,
  updatedAt: row.workItem.updatedAt,
  stateReadyAt: row.workItem.stateReadyAt,
  postponedUntil: row.workItem.postponedUntil,
})

const toStatusLanes = (
  lanes: readonly {
    readonly id: string
    readonly label: string
    readonly count: number
    readonly workItems: readonly {
      readonly repository: {
        readonly id: string
        readonly forge: string
        readonly forgeHost: string
        readonly projectPath: string
      }
      readonly workItem: {
        readonly id: string
        readonly issueNumber: number
        readonly issueTitle: string | null
        readonly state: string
        readonly status: string
        readonly statusMessage: string | null
        readonly paused: boolean
        readonly pullRequestNumber: number | null
        readonly createdAt: string
        readonly updatedAt: string
        readonly stateReadyAt: string
        readonly postponedUntil: string | null
      }
    }[]
  }[],
): readonly StatusLane[] =>
  lanes.map((lane) => {
    if (!isStatusLaneId(lane.id)) {
      throw new Error(`Unexpected Kanban lane id from GraphQL: ${lane.id}`)
    }
    return {
      id: lane.id,
      label: lane.label,
      count: lane.count,
      workItems: lane.workItems.map(toStatusWorkItemRow),
    }
  })

export class GraphqlApi extends Context.Service<
  GraphqlApi,
  {
    readonly addRepository: (
      repository: LocalRepository,
    ) => Effect.Effect<RepositorySummary, GraphqlRequestFailed>
    readonly listRepositories: Effect.Effect<
      readonly ConfiguredRepository[],
      GraphqlRequestFailed
    >
    readonly intakeCandidates: (
      repositoryId: string,
    ) => Effect.Effect<IntakeCandidatesResult, GraphqlRequestFailed>
    readonly startRepositoryIntake: (
      repositoryId: string,
    ) => Effect.Effect<RepositoryIntakeResult, GraphqlRequestFailed>
    readonly kanbanStatus: (
      repositoryId: string | null,
    ) => Effect.Effect<KanbanStatusResult, GraphqlRequestFailed>
  }
>()("ready-for-agent/GraphqlApi") {
  static readonly layer = Layer.effect(
    GraphqlApi,
    Effect.gen(function* () {
      const config = yield* ApplicationConfig
      const client = createClient({
        url: config.graphqlUrl,
        fetch: createGraphqlEndpointFetch(config.graphqlUrl),
      })

      const mapFailure = (cause: unknown): GraphqlRequestFailed => {
        const failure = describeGraphqlFailure(cause, {
          graphqlUrl: config.graphqlUrl,
        })
        return new GraphqlRequestFailed({
          code: failure.code,
          message: failure.message,
        })
      }

      const addRepository = Effect.fn("GraphqlApi.addRepository")(function* (
        repository: LocalRepository,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await client.mutation({
              addRepository: {
                __args: {
                  input: {
                    forge: repository.forge,
                    forgeHost: repository.forgeHost,
                    projectPath: repository.projectPath,
                    localPath: repository.localPath,
                    isBare: repository.isBare,
                  },
                },
                id: true,
                forge: true,
                forgeHost: true,
                projectPath: true,
                localPath: true,
                isBare: true,
              },
            })
            const added = result.addRepository
            if (!added) {
              throw new Error("addRepository returned null")
            }
            return added
          },
          catch: mapFailure,
        })
      })

      const listRepositories = Effect.tryPromise({
        try: async () => {
          const result = await client.query({
            repositories: {
              id: true,
              forge: true,
              forgeHost: true,
              projectPath: true,
            },
          })
          return result.repositories ?? []
        },
        catch: mapFailure,
      }).pipe(Effect.withSpan("GraphqlApi.listRepositories"))

      const intakeCandidates = Effect.fn("GraphqlApi.intakeCandidates")(
        function* (repositoryId: string) {
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await client.query({
                intakeCandidates: {
                  __args: { repositoryId },
                  repository: {
                    id: true,
                    forge: true,
                    forgeHost: true,
                    projectPath: true,
                    issuesReconciledAt: true,
                  },
                  candidates: {
                    issueNumber: true,
                    title: true,
                    url: true,
                    action: true,
                  },
                },
              })
              const payload = result.intakeCandidates
              if (!payload) {
                throw new Error("intakeCandidates returned null")
              }
              return {
                repository: {
                  id: payload.repository.id,
                  forge: payload.repository.forge,
                  forgeHost: payload.repository.forgeHost,
                  projectPath: payload.repository.projectPath,
                  issuesReconciledAt:
                    payload.repository.issuesReconciledAt ?? null,
                },
                candidates: payload.candidates.map(
                  (candidate: {
                    readonly issueNumber: number
                    readonly title: string
                    readonly url: string
                    readonly action: IntakeCandidateAction
                  }) => ({
                    issueNumber: candidate.issueNumber,
                    title: candidate.title,
                    url: candidate.url,
                    action: candidate.action,
                  }),
                ),
              }
            },
            catch: mapFailure,
          })
        },
      )

      const startRepositoryIntake = Effect.fn(
        "GraphqlApi.startRepositoryIntake",
      )(function* (repositoryId: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await client.mutation({
              startRepositoryIntake: {
                __args: { repositoryId },
                repository: {
                  id: true,
                  forge: true,
                  forgeHost: true,
                  projectPath: true,
                  issuesReconciledAt: true,
                },
                results: {
                  on_RepositoryIntakeCreated: {
                    __typename: true,
                    issueNumber: true,
                    title: true,
                    url: true,
                    action: true,
                    workItem: {
                      id: true,
                      state: true,
                      status: true,
                    },
                  },
                  on_RepositoryIntakeFailed: {
                    __typename: true,
                    issueNumber: true,
                    title: true,
                    url: true,
                    action: true,
                    error: {
                      code: true,
                      message: true,
                    },
                  },
                },
              },
            })
            const payload = result.startRepositoryIntake
            if (!payload) {
              throw new Error("startRepositoryIntake returned null")
            }
            const results: IntakeIssueResult[] = []
            for (const entry of payload.results ?? []) {
              // Genql union selection uses on_* fragments; __typename discriminates.
              if (
                entry !== null &&
                typeof entry === "object" &&
                "__typename" in entry &&
                entry.__typename === "RepositoryIntakeCreated" &&
                "workItem" in entry &&
                entry.workItem !== null &&
                entry.workItem !== undefined
              ) {
                results.push({
                  issueNumber: entry.issueNumber,
                  title: entry.title,
                  url: entry.url,
                  action: entry.action,
                  outcome: "CREATED",
                  workItem: {
                    id: entry.workItem.id,
                    state: entry.workItem.state,
                    status: entry.workItem.status,
                  },
                })
                continue
              }
              if (
                entry !== null &&
                typeof entry === "object" &&
                "__typename" in entry &&
                entry.__typename === "RepositoryIntakeFailed" &&
                "error" in entry &&
                entry.error !== null &&
                entry.error !== undefined
              ) {
                results.push({
                  issueNumber: entry.issueNumber,
                  title: entry.title,
                  url: entry.url,
                  action: entry.action,
                  outcome: "FAILED",
                  error: {
                    code: entry.error.code,
                    message: entry.error.message,
                  },
                })
                continue
              }
              throw new Error(
                "startRepositoryIntake returned an unexpected result shape",
              )
            }
            return {
              repository: {
                id: payload.repository.id,
                forge: payload.repository.forge,
                forgeHost: payload.repository.forgeHost,
                projectPath: payload.repository.projectPath,
                issuesReconciledAt:
                  payload.repository.issuesReconciledAt ?? null,
              },
              results,
            }
          },
          catch: mapFailure,
        })
      })

      const kanbanStatus = Effect.fn("GraphqlApi.kanbanStatus")(function* (
        repositoryId: string | null,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await client.query({
              kanbanStatus: {
                __args: repositoryId === null ? {} : { repositoryId },
                repository: {
                  id: true,
                  forge: true,
                  forgeHost: true,
                  projectPath: true,
                },
                lanes: {
                  id: true,
                  label: true,
                  count: true,
                  workItems: {
                    repository: {
                      id: true,
                      forge: true,
                      forgeHost: true,
                      projectPath: true,
                    },
                    workItem: {
                      id: true,
                      issueNumber: true,
                      issueTitle: true,
                      state: true,
                      status: true,
                      statusMessage: true,
                      paused: true,
                      pullRequestNumber: true,
                      createdAt: true,
                      updatedAt: true,
                      stateReadyAt: true,
                      postponedUntil: true,
                    },
                  },
                },
              },
            })
            const status = result.kanbanStatus
            if (!status) {
              throw new Error("kanbanStatus returned null")
            }
            return {
              repository:
                status.repository === null || status.repository === undefined
                  ? null
                  : toCanonicalRepositoryIdentity(status.repository),
              lanes: toStatusLanes(status.lanes ?? []),
            }
          },
          catch: mapFailure,
        })
      })

      return {
        addRepository,
        listRepositories,
        intakeCandidates,
        startRepositoryIntake,
        kanbanStatus,
      }
    }),
  )
}
