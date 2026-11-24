import { makeGitHubServiceFromToken } from "@ready-for-agent/github-service"
import { makeLinearServiceFromToken } from "@ready-for-agent/linear-service"

interface Approval {
  readonly title: string
  readonly description: string
  readonly comments: readonly { readonly url: string; readonly body: string }[]
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
    reopen: (createdAt = "2026-11-24T00:00:00Z") => {
      tracker.closed = false
      reopenEvents.unshift({
        id: `reopen-${reopenEvents.length + 1}`,
        createdAt,
      })
    },
  }
  const children = () => [
    { id: "cancelled-child", open: tracker.childOpen },
    ...(tracker.childAdded ? [{ id: "new-child", open: false }] : []),
  ]
  const ok = (data: unknown) => Response.json({ data })
  const comments = () =>
    [
      ...approval.comments,
      ...tracker.comments.map((body, index) => ({
        url: `${specUrl}#verdict-${index + 1}`,
        body,
      })),
    ].map((comment, index) => ({
      ...comment,
      id: `comment-${index + 1}`,
      editedAt: null,
      lastEditedAt: null,
    }))

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
            addComment: { commentEdge: { node: { body } } },
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
      if (query.includes("subIssues(")) {
        const nodes = children().map(({ id, open }) => ({
          id,
          state: open ? "OPEN" : "CLOSED",
          stateReason: open ? null : "NOT_PLANNED",
          closedAt: open ? null : tracker.closedAt,
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
        return ok({
          repository: { issues: page(tracker.closed ? [] : [root]) },
        })
      }
      if (query.includes("timelineItems(") && tracker.historyUnavailable) {
        return Response.json({ errors: [{ message: "History unavailable" }] })
      }
      return ok({
        repository: {
          issue: {
            ...root,
            comments: page(comments()),
            timelineItems: { nodes: reopenEvents.slice(0, 1) },
          },
        },
      })
    },
  )

  const linear = makeLinearServiceFromToken(
    "test-token",
    async (_url, init) => {
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
        if (variables.issueId !== root.id)
          throw new Error("Wrong comment target")
        const body: string = variables.body
        tracker.comments.push(body)
        return (
          tracker.afterPublication() ??
          ok({
            commentCreate: {
              success: true,
              comment: { id: `comment-${tracker.comments.length}`, body },
            },
          })
        )
      }
      if (query.includes("mutation CommentUpdate")) {
        const index =
          Number(String(variables.id).replace("comment-", "")) -
          approval.comments.length -
          1
        if (tracker.comments[index] === undefined)
          throw new Error("Wrong verdict comment target")
        const body: string = variables.body
        tracker.comments[index] = body
        return ok({
          commentUpdate: { success: true, comment: { id: variables.id, body } },
        })
      }
      if (
        query.includes("query SpecToClose") &&
        tracker.closeGuardUnauthorized
      ) {
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
      if (query.includes("query SpecChildren")) {
        return ok({
          issue: tracker.incomplete
            ? null
            : {
                id: root.id,
                children: page(
                  children().map(({ id, open }) => ({
                    id,
                    state: { type: open ? "started" : "canceled" },
                    completedAt: null,
                    canceledAt: open ? null : tracker.closedAt,
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
    },
  )

  return { tracker, github, linear }
}
