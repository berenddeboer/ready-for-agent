import { makeGitHubServiceFromToken } from "@ready-for-agent/github-service"
import { makeLinearServiceFromToken } from "@ready-for-agent/linear-service"

interface Approval {
  readonly title: string
  readonly description: string
  readonly comments?: readonly { readonly url: string; readonly body: string }[]
}

interface NativeChild {
  readonly id: string
  readonly number: number
  readonly url: string
  readonly body: string
  readonly labelIds: readonly string[]
  readonly comments: { url: string; body: string; automation: boolean }[]
  state: "open" | "completed" | "canceled"
}

const page = (nodes: readonly unknown[]) => ({
  nodes,
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
})

/** A mutable tracker at the HTTP boundary; the adapters and lifecycle are real. */
export const specCloseOutTracker = (specUrl: string, approval: Approval) => {
  const reopenEvents: { id: string; createdAt: string }[] = []
  const tracker = {
    closed: false,
    canceled: false,
    childOpen: false,
    childAdded: false,
    incomplete: false,
    historyUnavailable: false,
    closeGuardUnauthorized: false,
    childReopenEventId: null as string | null,
    closedAt: "2026-11-24T00:00:00Z",
    afterPublication: (): Response | undefined => undefined,
    beforeClose: (): Response | undefined => undefined,
    comments: [] as string[],
    followUps: new Map<string, NativeChild>(),
    reopen: (createdAt = "2026-11-24T00:00:00Z") => {
      tracker.closed = false
      reopenEvents.unshift({
        id: `reopen-${reopenEvents.length + 1}`,
        createdAt,
      })
    },
  }
  const children = () => [
    {
      id: "cancelled-child",
      state: tracker.childOpen ? "open" : "canceled",
      url: undefined,
    },
    ...(tracker.childAdded
      ? [{ id: "new-child", state: "canceled", url: undefined }]
      : []),
    ...tracker.followUps.values(),
  ]
  const approvalComments = approval.comments ?? []
  const ok = (data: unknown) => Response.json({ data })
  const comments = () =>
    [
      ...approvalComments,
      ...tracker.comments.map((body, index) => ({
        url: `${specUrl}#verdict-${index + 1}`,
        body,
      })),
    ].map((comment, index) => ({
      ...comment,
      id: `comment-${index + 1}`,
      editedAt: null,
      lastEditedAt: null,
      author: null,
      user: null,
      botActor: null,
      agentSession: null,
      onBehalfOf: null,
    }))
  const childComments = (child: NativeChild | undefined) =>
    page(
      (child?.comments ?? []).map(({ url, body, automation }, index) => ({
        id: `child-comment-${index + 1}`,
        url,
        body,
        author: { login: "operator", __typename: automation ? "Bot" : "User" },
        user: { name: "Operator", app: false },
        botActor: null,
        agentSession: automation ? { id: "agent-session" } : null,
        onBehalfOf: null,
      })),
    )

  const github = makeGitHubServiceFromToken(
    "test-token",
    async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body))
      const root = {
        id: "spec-node",
        state: tracker.closed ? "CLOSED" : "OPEN",
        stateReason: tracker.closed
          ? tracker.canceled
            ? "NOT_PLANNED"
            : "COMPLETED"
          : null,
        number: 7,
        url: specUrl,
        title: approval.title,
        body: approval.description,
        labels: page([{ name: "spec" }]),
      }
      if (query.includes("addComment(")) {
        const { body } = Object.values(variables)[0] as { body: string }
        tracker.comments.push(body)
        return (
          tracker.afterPublication() ??
          ok({
            addComment: {
              commentEdge: {
                node: {
                  id: `comment-${approvalComments.length + tracker.comments.length}`,
                  body,
                },
              },
            },
          })
        )
      }
      if (query.includes("closeIssue(")) {
        if (tracker.comments.length === 0)
          throw new Error("Close preceded verdict")
        const failure = tracker.beforeClose()
        if (failure) return failure
        tracker.closed = true
        return ok({ closeIssue: { issue: { state: "CLOSED" } } })
      }
      if (query.includes("createIssue(")) {
        const { parentIssueId, labelIds, body } = Object.values(
          variables,
        )[0] as {
          parentIssueId: string
          labelIds: string[]
          body: string
        }
        if (parentIssueId !== root.id) throw new Error("Wrong follow-up parent")
        const number = tracker.followUps.size + 8
        const child: NativeChild = {
          id: `follow-up-${number}`,
          number,
          url: new URL(`${number}`, specUrl).href,
          body,
          labelIds,
          state: "open",
          comments: [],
        }
        tracker.followUps.set(child.id, child)
        return ok({
          createIssue: {
            issue: {
              ...child,
              state: "OPEN",
              parent: { id: root.id },
              labels: page(labelIds.map((id) => ({ id }))),
            },
          },
        })
      }
      if (query.includes("label("))
        return ok({
          repository: {
            label: {
              id: Object.values(variables).find(
                (value) =>
                  value === "ready-for-agent" || value === "ready-for-human",
              ),
            },
          },
        })
      if (query.includes("node(") && query.includes("subIssues(")) {
        const nodes = children().map(({ id, state, url }) => ({
          id,
          url,
          state: state === "open" ? "OPEN" : "CLOSED",
          stateReason:
            state === "open"
              ? null
              : state === "completed"
                ? "COMPLETED"
                : "NOT_PLANNED",
          closedAt: state === "open" ? null : tracker.closedAt,
          timelineItems: {
            nodes:
              tracker.childReopenEventId === null
                ? []
                : [
                    {
                      id: tracker.childReopenEventId,
                      createdAt: tracker.closedAt,
                    },
                  ],
          },
          subIssuesSummary: { total: 0 },
        }))
        return ok({
          node: {
            ...root,
            subIssuesSummary: { total: nodes.length },
            subIssues: page(tracker.incomplete ? nodes.slice(1) : nodes),
          },
        })
      }
      if (query.includes("issues(")) {
        if (
          Object.values(variables).some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "createdBy" in value,
          )
        )
          return ok({
            repository: {
              issues: page(
                [...tracker.followUps.values()].map((child) => ({
                  ...child,
                  author: { login: "harness" },
                })),
              ),
            },
          })
        if (
          query.includes("ready-for-agent") ||
          Object.values(variables).some(
            (value) =>
              Array.isArray(value) && value.includes("ready-for-agent"),
          )
        )
          return ok({ repository: { issues: page([]) } })
        return ok({
          repository: { issues: page(tracker.closed ? [] : [root]) },
        })
      }
      if (query.includes("node(") && query.includes("comments(")) {
        const id = Object.values(variables)[0]
        if (typeof id !== "string") throw new Error("Missing child identity")
        return ok({
          node: { id, comments: childComments(tracker.followUps.get(id)) },
        })
      }
      if (query.includes("timelineItems(") && tracker.historyUnavailable) {
        return Response.json({ errors: [{ message: "History unavailable" }] })
      }
      return ok({
        viewer: { login: "harness" },
        repository: {
          id: "repository",
          issue: {
            ...root,
            comments: page(comments()),
            timelineItems: { nodes: reopenEvents.slice(0, 1) },
          },
        },
      })
    },
  )

  const linearFetch = async (
    _url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const { query, variables } = JSON.parse(String(init?.body))
    const root = {
      id: "linear-native-id",
      identifier: "ENG-7",
      url: specUrl,
      title: approval.title,
      description: approval.description,
      state: tracker.closed
        ? tracker.canceled
          ? { id: "canceled", name: "Canceled", type: "canceled" }
          : { id: "done", name: "Done", type: "completed" }
        : { id: "started", name: "In Progress", type: "started" },
      team: { id: "team", key: "ENG" },
      specLabels: page([{ name: "spec" }]),
    }
    if (query.includes("mutation CommentCreate")) {
      if (variables.issueId !== root.id) throw new Error("Wrong comment target")
      const body: string = variables.body
      tracker.comments.push(body)
      return (
        tracker.afterPublication() ??
        ok({
          commentCreate: {
            success: true,
            comment: {
              id: `comment-${approvalComments.length + tracker.comments.length}`,
              body,
            },
          },
        })
      )
    }
    if (query.includes("mutation CommentUpdate")) {
      const index =
        Number(String(variables.id).replace("comment-", "")) -
        approvalComments.length -
        1
      if (tracker.comments[index] === undefined)
        throw new Error("Wrong verdict comment target")
      const body: string = variables.body
      tracker.comments[index] = body
      return ok({
        commentUpdate: { success: true, comment: { id: variables.id, body } },
      })
    }
    if (query.includes("query SpecToClose") && tracker.closeGuardUnauthorized) {
      return Response.json({}, { status: 401 })
    }
    if (query.includes("mutation IssueUpdate")) {
      if (variables.id !== root.id || variables.stateId !== "done")
        throw new Error("Wrong close target")
      if (tracker.comments.length === 0)
        throw new Error("Close preceded verdict")
      const failure = tracker.beforeClose()
      if (failure) return failure
      tracker.closed = true
      return ok({
        issueUpdate: {
          success: true,
          issue: { id: root.id, state: { id: "done", type: "completed" } },
        },
      })
    }
    if (query.includes("query OpenSpecs")) {
      return ok({ issues: page(tracker.closed ? [] : [root]) })
    }
    if (query.includes("query ReadyIssues")) return ok({ issues: page([]) })
    if (query.includes("query Viewer")) return ok({ viewer: { id: "harness" } })
    if (query.includes("query FollowUpParent"))
      return ok({ issue: { ...root, project: { id: "validation-project" } } })
    if (query.includes("query FollowUpLabels"))
      return ok({
        issueLabels: page([{ id: variables.label, team: root.team }]),
      })
    const linearChild = (child: NativeChild) => ({
      ...child,
      state: { type: child.state === "open" ? "started" : child.state },
      parent: { id: root.id },
      project: { id: "validation-project" },
      labels: page(child.labelIds.map((id) => ({ id }))),
    })
    if (query.includes("query FindSpecFollowUp")) {
      const child = tracker.followUps.get(variables.id)
      return ok({ issues: page(child ? [linearChild(child)] : []) })
    }
    if (query.includes("mutation CreateSpecFollowUp")) {
      const { id, parentId, projectId, labelIds, description } = variables.input
      if (parentId !== root.id || projectId !== "validation-project")
        throw new Error("Wrong follow-up parent or project")
      const number = tracker.followUps.size + 8
      const child: NativeChild = {
        id,
        number,
        body: description,
        labelIds,
        state: "open",
        comments: [],
        url: new URL(`ENG-${number}`, specUrl).href,
      }
      tracker.followUps.set(id, child)
      return ok({ issueCreate: { success: true, issue: linearChild(child) } })
    }
    if (query.includes("query SpecConversation") && variables.id !== root.id)
      return ok({
        issue: {
          id: variables.id,
          comments: childComments(tracker.followUps.get(variables.id)),
        },
      })
    if (query.includes("query SpecChildren")) {
      return ok({
        issue: tracker.incomplete
          ? null
          : {
              id: root.id,
              children: page(
                children().map(({ id, state, url }) => ({
                  id,
                  url,
                  state: { type: state === "open" ? "started" : state },
                  completedAt: state === "completed" ? tracker.closedAt : null,
                  canceledAt: state === "canceled" ? tracker.closedAt : null,
                  children: page([]),
                })),
              ),
            },
      })
    }
    if (query.includes("query SpecHistory")) {
      const history =
        variables.after === null && reopenEvents.length > 0
          ? {
              nodes: [
                {
                  id: "unrelated-edit",
                  createdAt: "2026-11-24T00:01:00Z",
                  fromState: null,
                  toState: null,
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "older" },
            }
          : page(
              reopenEvents.map((event) => ({
                ...event,
                fromState: { type: "completed" },
                toState: { type: "started" },
              })),
            )
      return ok({ issue: { history } })
    }
    return ok({
      issue: {
        ...root,
        comments: page(comments()),
      },
    })
  }
  const linear = makeLinearServiceFromToken(
    "test-token",
    Object.assign(linearFetch, { preconnect: () => {} }),
  )

  return { tracker, github, linear }
}
