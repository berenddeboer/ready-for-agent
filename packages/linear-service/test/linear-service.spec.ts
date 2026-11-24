import { Effect, Result } from "effect"
import type { SpecFollowUpPublication } from "@ready-for-agent/forge-contract"
import { LinearRequestError } from "../src/lib/errors.js"
import { makeLinearServiceFromToken } from "../src/lib/linear-service-live.js"
import {
  linearMilestoneMarker,
  suggestDoneState,
  suggestInProgressState,
  unreadableLinearBlockerNativeId,
} from "../src/lib/types.js"
import { describe, expect, test } from "bun:test"

const TOKEN = "lin_api_test"
const PROJECT_ID = "proj-1"
const ISSUE_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
const PARENT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901"
const BLOCKER_UUID = "c3d4e5f6-a7b8-9012-cdef-123456789012"
const RELATION_ID = "rel-unreadable"

type GraphqlBody = {
  readonly query: string
  readonly variables?: Record<string, unknown>
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const makeFetch = (handler: (body: GraphqlBody) => Response): typeof fetch =>
  (async (_url, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as GraphqlBody
    return handler(parsed)
  }) as typeof fetch

test("recovers a partial Linear native follow-up and posts the findings only once", async () => {
  const url = "https://linear.app/acme/issue/ENG-8"
  const regionalUrl = "https://linear.app/acme/issue/ENG-9"
  const payload: SpecFollowUpPublication = {
    parentId: PARENT_UUID,
    parentUrl: "https://linear.app/acme/issue/ENG-7",
    workItemId: "wi-test",
    findings: "Deployed MCP is unverified: production access required",
    children: [
      {
        requirementId: "deployed-mcp",
        gapId: "public-route",
        title: "Verify deployed MCP",
        body: "Approved requirement: deployed initialize. Access unavailable. The operator should check for a successful initialize.",
        label: "ready-for-human",
      },
      {
        requirementId: "deployed-mcp",
        gapId: "regional-route",
        title: "Restore regional deployed MCP",
        body: "Regional endpoint returns HTTP 404.",
        label: "ready-for-agent",
      },
    ],
  }
  const parent = {
    id: PARENT_UUID,
    project: { id: PROJECT_ID },
    team: { id: "spec-team" },
    state: { type: "started" },
  }
  const pageInfo = { hasNextPage: false, endCursor: null }
  const comments: Array<{ id: string; body: string }> = []
  const child: {
    id: unknown
    url: string
    parent: { id: string } | null
    project: { id: string } | null
    labels: { nodes: Array<{ id: string }>; pageInfo: typeof pageInfo }
    state: { type: string }
  } = {
    id: null,
    url,
    parent: null,
    project: null,
    labels: { nodes: [], pageInfo },
    state: { type: "unstarted" },
  }
  let creates = 0
  let humanLabelAvailable = false
  let loseCommentUpdate = true
  const regional = { ...child, url: regionalUrl }
  let issueDescription: unknown
  const service = makeLinearServiceFromToken(
    TOKEN,
    makeFetch(({ query, variables }) => {
      const data = (result: unknown) => jsonResponse(200, { data: result })
      if (query.includes("FollowUpParent")) return data({ issue: parent })
      if (query.includes("FollowUpLabels")) {
        const human = variables?.label === "ready-for-human"
        return data({
          issueLabels: {
            nodes:
              human && !humanLabelAvailable
                ? []
                : [
                    { id: "other-team-label", team: { id: "another-team" } },
                    { id: "workspace-label", team: null },
                    {
                      id: human ? "human-label" : "agent-label",
                      team: parent.team,
                    },
                  ],
            pageInfo,
          },
        })
      }
      if (query.includes("FindSpecFollowUp")) {
        const found = [child, regional].filter(
          ({ id }) => id !== null && id === variables?.id,
        )
        return data({
          issues: { nodes: found, pageInfo },
        })
      }
      if (query.includes("CreateSpecFollowUp")) {
        creates += 1
        const input = variables?.input
        const isRegional = creates === 1
        expect(input).toMatchObject({
          parentId: parent.id,
          projectId: PROJECT_ID,
          teamId: parent.team.id,
          labelIds: [isRegional ? "agent-label" : "human-label"],
          title: payload.children[isRegional ? 1 : 0].title,
        })
        if (
          typeof input !== "object" ||
          input === null ||
          !("id" in input) ||
          !("description" in input)
        ) {
          throw new Error("Missing stable Linear child ID or description")
        }
        expect(input.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        if (isRegional) {
          regional.id = input.id
          regional.parent = { id: parent.id }
          regional.project = parent.project
          regional.labels = { nodes: [{ id: "agent-label" }], pageInfo }
          return data({ issueCreate: { success: true, issue: regional } })
        }
        expect(input.id).not.toBe(regional.id)
        child.id = input.id
        issueDescription = input.description
        return jsonResponse(500, {})
      }
      if (query.includes("RepairSpecFollowUp")) {
        expect(variables?.id).toBe(child.id)
        expect(variables?.input).toEqual({
          parentId: parent.id,
          projectId: PROJECT_ID,
          addedLabelIds: ["human-label"],
        })
        child.parent = { id: parent.id }
        child.project = parent.project
        child.labels.nodes = [{ id: "human-label" }]
        return data({ issueUpdate: { success: true, issue: child } })
      }
      if (query.includes("IssueComments"))
        return data({
          issue: { id: parent.id, comments: { nodes: comments, pageInfo } },
        })
      if (query.includes("CommentCreate")) {
        expect(variables?.issueId).toBe(parent.id)
        comments.push({ id: "comment", body: String(variables?.body) })
        return data({ commentCreate: { success: true, comment: comments[0] } })
      }
      if (query.includes("CommentUpdate")) {
        expect(variables?.id).toBe(comments[0]?.id)
        const updated = {
          id: String(variables?.id),
          body: String(variables?.body),
        }
        comments[0] = updated
        if (loseCommentUpdate) {
          loseCommentUpdate = false
          return jsonResponse(500, {})
        }
        return data({ commentUpdate: { success: true, comment: updated } })
      }
      throw new Error(`Unexpected Linear API operation: ${query}`)
    }),
  )
  const publish = () =>
    Effect.runPromise(service.publishSpecFollowUps(PROJECT_ID, payload))
  await expect(publish()).rejects.toThrow(
    "resolve Linear Issue label ready-for-human",
  )
  expect(creates).toBe(1)
  expect(regional.parent?.id).toBe(parent.id)
  expect(comments[0]?.body).toContain(regionalUrl)
  expect(comments[0]?.body).toContain("Follow-ups not yet published")
  humanLabelAvailable = true
  await expect(publish()).rejects.toThrow("creating Linear follow-up")
  await expect(publish()).rejects.toThrow("updating a Linear milestone comment")
  await expect(publish()).resolves.toEqual([
    {
      requirementId: "deployed-mcp",
      gapId: "public-route",
      nativeId: child.id,
      url,
    },
    {
      requirementId: "deployed-mcp",
      gapId: "regional-route",
      nativeId: regional.id,
      url: regionalUrl,
    },
  ])
  expect(creates).toBe(2)
  expect(child.parent?.id).toBe(parent.id)
  expect(child.project?.id).toBe(PROJECT_ID)
  expect(child.labels.nodes).toEqual([{ id: "human-label" }])
  expect(issueDescription).toContain("Access unavailable")
  expect(comments.map(({ body }) => body)).toEqual([
    expect.stringContaining(url),
  ])
  expect(comments[0]?.body).toContain("unverified")
  expect(comments[0]?.body).toContain(regionalUrl)
  expect(comments[0]?.body).not.toContain("Follow-ups not yet published")
  await Effect.runPromise(
    service.publishSpecFollowUps(PROJECT_ID, {
      ...payload,
      findings: "Follow-up drafts corrected",
    }),
  )
  expect(comments.map(({ body }) => body)).toEqual([
    expect.stringContaining("Follow-up drafts corrected"),
  ])
  expect(parent.state.type).toBe("started")
})

describe("Linear Spec baseline", () => {
  const url = "https://linear.app/acme/issue/ENG-1/hosted-mcp"
  const design = `https://github.com/acme/widgets/blob/${"a".repeat(40)}/design.md`
  const title = "Hosted MCP"
  const approvedBody = `Expose MCP both locally and when deployed.\n\n[Approved design baseline: ADR](<${design}>)`
  const specLabels = { nodes: [{ name: "Spec" }] }

  test("reads a marked Linear Spec directly as written without reading comments", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        expect(variables?.id).toBe(ISSUE_UUID)
        expect(query).toStartWith("query Spec")
        return jsonResponse(200, {
          data: {
            issue: {
              title,
              description: approvedBody,
              url,
              specLabels,
            },
          },
        })
      }),
    )
    await expect(
      Effect.runPromise(service.readSpecBaseline(ISSUE_UUID)),
    ).resolves.toEqual({
      kind: "baseline",
      baseline: { title, body: approvedBody, url },
    })
  })

  test("does not offer a marked, Ready-labeled Linear Spec before it has children", async () => {
    const issue = (number: number, marked: boolean, hasChildren: boolean) => ({
      id: `id-${number}`,
      identifier: `ENG-${number}`,
      number,
      title,
      url,
      createdAt: "2026-11-24T00:00:00Z",
      specLabels: marked ? specLabels : { nodes: [] },
      children: { nodes: hasChildren ? [{ id: "child" }] : [] },
    })
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query }) => {
        expect(query).toContain('labels: { name: { eq: "ready-for-agent" } }')
        expect(query).toContain('filter: { name: { eqIgnoreCase: "spec" } }')
        return jsonResponse(200, {
          data: {
            issues: {
              nodes: [
                issue(1, true, false),
                issue(2, false, true),
                issue(3, false, false),
              ],
            },
          },
        })
      }),
    )
    expect(
      (await Effect.runPromise(service.listReadyIssues(PROJECT_ID))).map(
        ({ number, hasChildren }) => ({ number, hasChildren }),
      ),
    ).toEqual([
      { number: 2, hasChildren: true },
      { number: 3, hasChildren: false },
    ])
  })
})

describe("Linear workflow defaults", () => {
  test("prefers In Progress among started states and Done among completed", () => {
    expect(
      suggestInProgressState([
        { id: "s1", name: "Doing", type: "started", position: 1 },
        { id: "s2", name: "In Progress", type: "started", position: 2 },
      ])?.id,
    ).toBe("s2")
    expect(
      suggestDoneState([
        { id: "d1", name: "Shipped", type: "completed", position: 1 },
        { id: "d2", name: "Done", type: "completed", position: 2 },
      ])?.id,
    ).toBe("d2")
  })

  test("falls back to the first started or completed state", () => {
    expect(
      suggestInProgressState([
        { id: "s1", name: "Doing", type: "started", position: 1 },
      ])?.id,
    ).toBe("s1")
    expect(
      suggestDoneState([
        { id: "d1", name: "Shipped", type: "completed", position: 1 },
      ])?.id,
    ).toBe("d1")
  })
})

describe("Linear Spec observation", () => {
  const node = (id: string, type: string, firstChildId?: string) => ({
    id,
    state: { type },
    completedAt: type === "completed" ? "2026-11-24T00:00:00Z" : null,
    canceledAt: type === "canceled" ? "2026-11-24T00:00:00Z" : null,
    children: page(firstChildId === undefined ? [] : [{ id: firstChildId }]),
  })
  const spec = (id: string, type = "started") => ({
    ...node(id, type),
    identifier: `ENG-${id}`,
    url: `https://linear.app/acme/issue/${id}`,
  })
  const page = (nodes: readonly unknown[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  })

  test("observes 600 closed leaves without a separate request per leaf", async () => {
    let childRequests = 0
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        if (query.includes("query OpenSpecs")) {
          return jsonResponse(200, { data: { issues: page([spec("root")]) } })
        }
        childRequests += 1
        const id = variables?.id
        const after = Number(variables?.after)
        const nodes =
          id === "root"
            ? Array.from({ length: 50 }, (_, index) =>
                node(`child-${after + index}`, "completed"),
              )
            : []
        const next = id === "root" && after < 550 ? String(after + 50) : null
        return jsonResponse(200, {
          data: { issue: { id, children: page(nodes, next) } },
        })
      }),
    )
    const observations = await Effect.runPromise(
      service.observeSpecs(PROJECT_ID),
    )
    expect(observations[0]?.readiness).toBe("all-descendants-closed")
    expect(childRequests).toBe(12)
  })

  test("batches reads for 600 intermediate issues without skipping a branch page", async () => {
    let childRequests = 0
    let lastLeafState = "completed"
    let lastBranchReadable = true
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        if (query.includes("query OpenSpecs")) {
          return jsonResponse(200, { data: { issues: page([spec("root")]) } })
        }
        childRequests += 1
        const issues = Object.entries(variables ?? {}).flatMap(([key, id]) => {
          if (!key.startsWith("id")) return []
          const suffix = key.slice(2)
          const after = variables?.[`after${suffix}`]
          if (id === "root") {
            const offset = Number(after)
            const branches = Array.from({ length: 50 }, (_, index) => {
              const number = offset + index
              return node(`branch-${number}`, "completed", `leaf-${number}`)
            })
            const next = offset < 550 ? String(offset + 50) : null
            return [[`issue${suffix}`, { id, children: page(branches, next) }]]
          }
          if (typeof id !== "string" || !id.startsWith("branch-")) {
            throw new Error(`Unexpected issue: ${id}`)
          }
          if (id === "branch-599" && after !== null && !lastBranchReadable) {
            return [[`issue${suffix}`, null]]
          }
          const children =
            after !== null
              ? page([node("last-leaf", lastLeafState)])
              : page(
                  [node(`leaf-${id.slice(7)}`, "completed")],
                  id === "branch-599" ? "last-page" : null,
                )
          return [[`issue${suffix}`, { id, children }]]
        })
        return jsonResponse(200, { data: Object.fromEntries(issues) })
      }),
    )
    const observe = () => Effect.runPromise(service.observeSpecs(PROJECT_ID))
    expect((await observe())[0]?.readiness).toBe("all-descendants-closed")
    expect(childRequests).toBeLessThan(100)
    lastLeafState = "started"
    expect((await observe())[0]?.readiness).toBe("waiting")
    lastBranchReadable = false
    expect((await observe())[0]?.readiness).toBe("hierarchy-unavailable")
  })

  test("observes an archived Spec whose workflow state is still open", async () => {
    const archivedSpec = {
      ...spec("archived"),
      archivedAt: "2026-07-01T00:00:00Z",
    }
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        if (query.includes("query OpenSpecs")) {
          // Linear omits archived issues unless the connection opts in.
          const nodes = query.includes("includeArchived: true")
            ? [archivedSpec]
            : []
          return jsonResponse(200, { data: { issues: page(nodes) } })
        }
        const id = variables?.id
        const nodes =
          id === archivedSpec.id ? [node("closed-child", "completed")] : []
        return jsonResponse(200, {
          data: { issue: { id, children: page(nodes) } },
        })
      }),
    )
    const observations = await Effect.runPromise(
      service.observeSpecs(PROJECT_ID),
    )
    expect(observations).toEqual([
      {
        nativeId: archivedSpec.id,
        displayId: archivedSpec.identifier,
        url: archivedSpec.url,
        readiness: "all-descendants-closed",
        descendants: [
          {
            nativeId: "closed-child",
            closureReason: "completed",
            closedAt: "2026-11-24T00:00:00Z",
          },
        ],
      },
    ])
  })

  test("identifies ready Specs on the first observation, through pages at each depth", async () => {
    let openOnLaterPage: string | undefined
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        const after = variables?.after
        if (query.includes("query OpenSpecs")) {
          expect(query).toContain('labels: { name: { eqIgnoreCase: "spec" } }')
          expect(query).toContain('type: { nin: ["completed", "canceled"] }')
          // An unmarked parent is not returned by the marker filter.
          return jsonResponse(200, {
            data: {
              issues:
                after === null
                  ? page(
                      [spec("childless"), spec("closed", "completed")],
                      "next-spec",
                    )
                  : page([spec("ready")]),
            },
          })
        }
        expect(query).toContain("includeArchived: true")
        const id = variables?.id
        const children =
          id === "ready"
            ? after === null
              ? page([node("first-child", "completed")], "next-child")
              : page([
                  node(
                    "second-child",
                    openOnLaterPage === "child" ? "started" : "completed",
                    "first-grandchild",
                  ),
                ])
            : id === "second-child"
              ? after === null
                ? page(
                    [node("first-grandchild", "completed")],
                    "next-grandchild",
                  )
                : page([
                    node(
                      "second-grandchild",
                      openOnLaterPage === "grandchild" ? "started" : "canceled",
                    ),
                  ])
              : page([])
        expect(id).not.toBe("closed")
        return jsonResponse(200, { data: { issue: { id, children } } })
      }),
    )
    const observations = await Effect.runPromise(
      service.observeSpecs(PROJECT_ID),
    )
    expect(
      observations.map(({ nativeId, readiness }) => [nativeId, readiness]),
    ).toEqual([
      ["childless", "waiting"],
      ["ready", "all-descendants-closed"],
    ])
    for (const depth of ["child", "grandchild"]) {
      openOnLaterPage = depth
      const updated = await Effect.runPromise(service.observeSpecs(PROJECT_ID))
      expect(
        updated.find(({ nativeId }) => nativeId === "ready")?.readiness,
      ).toBe("waiting")
    }
  })

  test.each([
    ["a missing connection", { data: { issue: { id: "child" } } }],
    ["an unreadable intermediate", { data: { issue: null } }],
    [
      "missing pagination",
      { data: { issue: { id: "child", children: { nodes: [] } } } },
    ],
    [
      "a missing continuation cursor",
      {
        data: {
          issue: {
            id: "child",
            children: {
              nodes: [node("grandchild", "completed")],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    ],
    [
      "a nested GraphQL error with usable-looking data",
      {
        data: { issue: { id: "child", children: page([]) } },
        errors: [
          {
            message: "Permission denied",
            path: ["issue", "children", "nodes", 0],
          },
        ],
      },
    ],
    [
      "a descendant with unknown state data",
      {
        data: {
          issue: {
            id: "child",
            children: page([{ id: "grandchild", state: null }]),
          },
        },
      },
    ],
  ])("does not report readiness with %s", async (_description, response) => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) => {
        if (query.includes("query OpenSpecs")) {
          return jsonResponse(200, { data: { issues: page([spec("root")]) } })
        }
        if (variables?.id === "root") {
          return jsonResponse(200, {
            data: {
              issue: {
                id: "root",
                children: page([node("child", "completed", "grandchild")]),
              },
            },
          })
        }
        return jsonResponse(200, response)
      }),
    )
    const observations = await Effect.runPromise(
      service.observeSpecs(PROJECT_ID),
    )
    expect(observations[0]?.readiness).toBe("hierarchy-unavailable")
  })

  test("a failed later descendant page invalidates earlier closed results", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(({ query, variables }) =>
        query.includes("query OpenSpecs")
          ? jsonResponse(200, { data: { issues: page([spec("root")]) } })
          : variables?.after === null
            ? jsonResponse(200, {
                data: {
                  issue: {
                    id: "root",
                    children: page([node("child", "completed")], "next"),
                  },
                },
              })
            : jsonResponse(503, {}),
      ),
    )
    const observations = await Effect.runPromise(
      service.observeSpecs(PROJECT_ID),
    )
    expect(observations[0]?.readiness).toBe("hierarchy-unavailable")
  })

  test.each([null, page([], "next")])(
    "does not mistake incomplete leaf data for a leaf: %j",
    async (children) => {
      const service = makeLinearServiceFromToken(
        TOKEN,
        makeFetch(({ query }) =>
          query.includes("query OpenSpecs")
            ? jsonResponse(200, { data: { issues: page([spec("root")]) } })
            : jsonResponse(200, {
                data: {
                  issue: {
                    id: "root",
                    children: page([
                      { ...node("child", "completed"), children },
                    ]),
                  },
                },
              }),
        ),
      )
      const observations = await Effect.runPromise(
        service.observeSpecs(PROJECT_ID),
      )
      expect(observations[0]?.readiness).toBe("hierarchy-unavailable")
    },
  )
})

describe("Linear identity and listing", () => {
  test("uses viewer id as the authenticated Linear user", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, { data: { viewer: { id: "user-linear-1" } } }),
      ),
    )
    await expect(
      Effect.runPromise(service.getAuthenticatedUserLogin()),
    ).resolves.toBe("user-linear-1")
  })

  test("returns an actionable error for an invalid API key", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(401, { errors: [{ message: "Unauthorized" }] }),
      ),
    )
    const result = await Effect.runPromise(
      service.getAuthenticatedUserLogin().pipe(Effect.result),
    )
    expect(result).toEqual(
      Result.fail(
        new LinearRequestError({
          message:
            "Linear API key is invalid or expired. Create a new personal API key and store it in Keymaxxer.",
          statusCode: 401,
          code: "AUTHENTICATION_ERROR",
        }),
      ),
    )
  })

  test("lists projects from the GraphQL connection", async () => {
    let requestBody: GraphqlBody | undefined
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((body) => {
        requestBody = body
        return jsonResponse(200, {
          data: {
            projects: {
              nodes: [
                {
                  id: "proj-b",
                  name: "Beta",
                  url: "https://linear.app/acme/project/beta",
                },
                { id: "proj-a", name: "Alpha", url: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      }),
    )
    await expect(Effect.runPromise(service.listProjects())).resolves.toEqual([
      { id: "proj-a", name: "Alpha", url: null },
      {
        id: "proj-b",
        name: "Beta",
        url: "https://linear.app/acme/project/beta",
      },
    ])
    expect(requestBody?.query).toContain(
      'status: { type: { nin: ["canceled"] } }',
    )
  })

  test("suggests team-specific In Progress and Done states", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, {
          data: {
            project: {
              id: PROJECT_ID,
              name: "Widgets",
              teams: {
                nodes: [
                  {
                    id: "team-eng",
                    key: "ENG",
                    name: "Engineering",
                    states: {
                      nodes: [
                        {
                          id: "todo",
                          name: "Todo",
                          type: "unstarted",
                          position: 0,
                        },
                        {
                          id: "progress",
                          name: "In Progress",
                          type: "started",
                          position: 1,
                        },
                        {
                          id: "done",
                          name: "Done",
                          type: "completed",
                          position: 2,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    )
    const workflow = await Effect.runPromise(
      service.listProjectWorkflow(PROJECT_ID),
    )
    expect(workflow).toEqual([
      {
        teamId: "team-eng",
        teamKey: "ENG",
        teamName: "Engineering",
        states: [
          { id: "todo", name: "Todo", type: "unstarted", position: 0 },
          { id: "progress", name: "In Progress", type: "started", position: 1 },
          { id: "done", name: "Done", type: "completed", position: 2 },
        ],
        suggestedInProgressStateId: "progress",
        suggestedDoneStateId: "done",
      },
    ])
  })

  test("keeps Linear UUID identity distinct from the display identifier", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((body) => {
        expect(JSON.stringify(body.variables)).toContain(PROJECT_ID)
        return jsonResponse(200, {
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_UUID,
                  identifier: "ENG-123",
                  number: 123,
                  title: "Ship Linear discovery",
                  description: "Use native identity.",
                  url: "https://linear.app/acme/issue/ENG-123",
                  createdAt: "2026-09-21T10:00:00.000Z",
                  creator: { id: "user-linear-1" },
                  parent: null,
                  children: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      }),
    )
    const issues = await Effect.runPromise(service.listReadyIssues(PROJECT_ID))
    expect(issues).toEqual([
      {
        number: 123,
        nativeId: ISSUE_UUID,
        displayId: "ENG-123",
        title: "Ship Linear discovery",
        body: "Use native identity.",
        url: "https://linear.app/acme/issue/ENG-123",
        createdAt: new Date("2026-09-21T10:00:00.000Z"),
        state: "OPEN",
        author: "user-linear-1",
        parent: null,
        parentPosition: null,
        hasChildren: false,
        hierarchySupported: true,
        blockedBy: [],
        closingPullRequests: [],
      },
    ])
    expect(issues[0]?.nativeId).not.toBe(issues[0]?.displayId)
    expect(Number.parseInt(issues[0]?.nativeId ?? "", 10)).toBeNaN()
  })

  test("includes readable blockers outside the mapped project and keeps unreadable blockers", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, {
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_UUID,
                  identifier: "ENG-10",
                  number: 10,
                  title: "Blocked leaf",
                  description: null,
                  url: "https://linear.app/acme/issue/ENG-10",
                  createdAt: "2026-09-21T10:00:00.000Z",
                  creator: { id: "user-linear-1" },
                  parent: {
                    id: PARENT_UUID,
                    identifier: "ENG-1",
                    number: 1,
                    url: "https://linear.app/acme/issue/ENG-1",
                    state: { type: "started" },
                    labels: { nodes: [{ name: "ready-for-agent" }] },
                  },
                  children: { nodes: [] },
                  inverseRelations: {
                    nodes: [
                      {
                        id: "rel-outside",
                        type: "blocks",
                        issue: {
                          id: BLOCKER_UUID,
                          identifier: "DES-9",
                          number: 9,
                          url: "https://linear.app/acme/issue/DES-9",
                          state: { type: "unstarted" },
                        },
                      },
                      {
                        id: RELATION_ID,
                        type: "blocks",
                        issue: null,
                      },
                      {
                        id: "rel-done",
                        type: "blocks",
                        issue: {
                          id: "done-blocker",
                          identifier: "ENG-2",
                          number: 2,
                          url: "https://linear.app/acme/issue/ENG-2",
                          state: { type: "completed" },
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    )
    const issues = await Effect.runPromise(service.listReadyIssues(PROJECT_ID))
    expect(issues[0]?.hasChildren).toBe(false)
    expect(issues[0]?.parent).toEqual({
      number: 1,
      url: "https://linear.app/acme/issue/ENG-1",
      nativeId: PARENT_UUID,
      displayId: "ENG-1",
      state: "OPEN",
      isReadyLabeled: true,
    })
    expect(issues[0]?.blockedBy).toEqual([
      {
        number: 9,
        url: "https://linear.app/acme/issue/DES-9",
        nativeId: BLOCKER_UUID,
        displayId: "DES-9",
      },
      {
        number: 1,
        url: `https://linear.app/#unreadable-${RELATION_ID}`,
        nativeId: unreadableLinearBlockerNativeId(RELATION_ID),
        displayId: "unreadable",
      },
    ])
  })

  test("keeps unreadable blockers when Linear returns nested field errors with data", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, {
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_UUID,
                  identifier: "ENG-10",
                  number: 10,
                  title: "Blocked leaf",
                  description: null,
                  url: "https://linear.app/acme/issue/ENG-10",
                  createdAt: "2026-09-21T10:00:00.000Z",
                  creator: { id: "user-linear-1" },
                  parent: null,
                  children: { nodes: [] },
                  inverseRelations: {
                    nodes: [
                      {
                        id: RELATION_ID,
                        type: "blocks",
                        issue: null,
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          errors: [
            {
              message: "Entity not found: Issue",
              path: [
                "issues",
                "nodes",
                0,
                "inverseRelations",
                "nodes",
                0,
                "issue",
              ],
            },
          ],
        }),
      ),
    )
    const issues = await Effect.runPromise(service.listReadyIssues(PROJECT_ID))
    expect(issues[0]?.blockedBy).toEqual([
      {
        number: 1,
        url: `https://linear.app/#unreadable-${RELATION_ID}`,
        nativeId: unreadableLinearBlockerNativeId(RELATION_ID),
        displayId: "unreadable",
      },
    ])
  })

  test("fails listing when Linear returns a GraphQL error without usable data", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, {
          data: null,
          errors: [{ message: "Something went wrong" }],
        }),
      ),
    )
    const error = await Effect.runPromise(
      Effect.flip(service.listReadyIssues(PROJECT_ID)),
    )
    expect(error).toBeInstanceOf(LinearRequestError)
    expect(error.message).toBe("Something went wrong")
  })

  test("does not treat assignment as authorship", async () => {
    let requestBody: GraphqlBody | undefined
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((body) => {
        requestBody = body
        return jsonResponse(200, {
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      }),
    )
    await Effect.runPromise(service.listReadyIssues(PROJECT_ID))
    expect(JSON.stringify(requestBody)).toContain("ready-for-agent")
    expect(JSON.stringify(requestBody)).not.toContain("assignee")
    expect(JSON.stringify(requestBody)).toContain("creator")
    expect(requestBody?.query).toContain("inverseRelations")
    expect(requestBody?.query).toContain("type")
    expect(requestBody?.query).not.toContain("blockedBy")
    expect(requestBody?.query).not.toContain("relations(first")
  })
})

describe("Linear execution mutations", () => {
  const issueNode = {
    id: ISSUE_UUID,
    identifier: "ENG-123",
    url: "https://linear.app/acme/issue/ENG-123",
    team: { id: "team-eng", key: "ENG" },
    state: { id: "todo", name: "Todo", type: "unstarted" },
  }
  const marker = "ready-for-agent:work-started:wi-1"
  const body = `Ready for Agent started implementation.\n\n${marker}`
  /** Linear comment `body` is markdown from ProseMirror; HTML comments vanish. */
  const linearStoredBody = (input: string): string =>
    input.replace(/<!--[\s\S]*?-->/g, "").trim()

  test("reads live Linear Issue identity, team, and workflow state", async () => {
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        expect(request.query).toContain("query Issue")
        expect(request.variables).toEqual({ id: ISSUE_UUID })
        return jsonResponse(200, { data: { issue: issueNode } })
      }),
    )
    await expect(
      Effect.runPromise(service.getIssue(ISSUE_UUID)),
    ).resolves.toEqual({
      id: ISSUE_UUID,
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      teamId: "team-eng",
      teamKey: "ENG",
      stateId: "todo",
      stateName: "Todo",
      stateType: "unstarted",
    })
  })

  test("moves an open Issue to In Progress and skips an already matching state", async () => {
    const operations: string[] = []
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        operations.push(
          request.query.includes("mutation IssueUpdate") ? "update" : "read",
        )
        if (request.query.includes("mutation IssueUpdate")) {
          expect(request.variables).toEqual({
            id: ISSUE_UUID,
            stateId: "progress",
          })
          return jsonResponse(200, {
            data: {
              issueUpdate: {
                success: true,
                issue: {
                  id: ISSUE_UUID,
                  state: { id: "progress", type: "started" },
                },
              },
            },
          })
        }
        return jsonResponse(200, { data: { issue: issueNode } })
      }),
    )
    await Effect.runPromise(service.updateIssueState(ISSUE_UUID, "progress"))
    expect(operations).toEqual(["read", "update"])

    const alreadyStarted = makeLinearServiceFromToken(
      TOKEN,
      makeFetch(() =>
        jsonResponse(200, {
          data: {
            issue: {
              ...issueNode,
              state: { id: "progress", name: "In Progress", type: "started" },
            },
          },
        }),
      ),
    )
    await Effect.runPromise(
      alreadyStarted.updateIssueState(ISSUE_UUID, "progress"),
    )
  })

  test("does not reopen a completed Linear Issue", async () => {
    let mutated = false
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        if (request.query.includes("mutation IssueUpdate")) {
          mutated = true
        }
        return jsonResponse(200, {
          data: {
            issue: {
              ...issueNode,
              state: { id: "done", name: "Done", type: "completed" },
            },
          },
        })
      }),
    )
    await Effect.runPromise(service.updateIssueState(ISSUE_UUID, "progress"))
    expect(mutated).toBe(false)
  })

  test("creates a milestone comment and reuses it on retry instead of duplicating", async () => {
    const operations: string[] = []
    const comments = { nodes: [] as Array<{ id: string; body: string }> }
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        if (request.query.includes("mutation CommentCreate")) {
          operations.push("create")
          const stored = linearStoredBody(
            String(request.variables?.body ?? body),
          )
          comments.nodes.push({ id: "comment-1", body: stored })
          return jsonResponse(200, {
            data: {
              commentCreate: {
                success: true,
                comment: { id: "comment-1", body: stored },
              },
            },
          })
        }
        if (request.query.includes("mutation CommentUpdate")) {
          operations.push("update")
          return jsonResponse(200, {
            data: {
              commentUpdate: {
                success: true,
                comment: { id: "comment-1", body },
              },
            },
          })
        }
        operations.push("list")
        return jsonResponse(200, {
          data: {
            issue: {
              id: ISSUE_UUID,
              comments: {
                nodes: comments.nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        })
      }),
    )
    await Effect.runPromise(
      service.ensureMilestoneComment(ISSUE_UUID, marker, body),
    )
    await Effect.runPromise(
      service.ensureMilestoneComment(ISSUE_UUID, marker, body),
    )
    expect(operations).toEqual(["list", "create", "list"])
  })

  test("updates an existing milestone comment when the body changes", async () => {
    const updatedBody = `Ready for Agent opened a pull request.\n\n${marker}`
    let updated: string | undefined
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        if (request.query.includes("mutation CommentUpdate")) {
          updated = String(request.variables?.body ?? "")
          return jsonResponse(200, {
            data: {
              commentUpdate: {
                success: true,
                comment: { id: "comment-1", body: updatedBody },
              },
            },
          })
        }
        return jsonResponse(200, {
          data: {
            issue: {
              id: ISSUE_UUID,
              comments: {
                nodes: [{ id: "comment-1", body }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        })
      }),
    )
    await Effect.runPromise(
      service.ensureMilestoneComment(ISSUE_UUID, marker, updatedBody),
    )
    expect(updated).toBe(updatedBody)
  })

  test("reuses a milestone after Linear strips HTML comments from the stored body", async () => {
    const operations: string[] = []
    const comments = { nodes: [] as Array<{ id: string; body: string }> }
    const mixedBody = `${body}\n<!-- ready-for-agent:work-started:wi-1 -->`
    const service = makeLinearServiceFromToken(
      TOKEN,
      makeFetch((request) => {
        if (request.query.includes("mutation CommentCreate")) {
          operations.push("create")
          const stored = linearStoredBody(String(request.variables?.body ?? ""))
          comments.nodes.push({ id: "comment-1", body: stored })
          return jsonResponse(200, {
            data: {
              commentCreate: {
                success: true,
                comment: { id: "comment-1", body: stored },
              },
            },
          })
        }
        if (request.query.includes("mutation CommentUpdate")) {
          operations.push("update")
          const stored = linearStoredBody(String(request.variables?.body ?? ""))
          comments.nodes[0] = { id: "comment-1", body: stored }
          return jsonResponse(200, {
            data: {
              commentUpdate: {
                success: true,
                comment: { id: "comment-1", body: stored },
              },
            },
          })
        }
        operations.push("list")
        return jsonResponse(200, {
          data: {
            issue: {
              id: ISSUE_UUID,
              comments: {
                nodes: comments.nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        })
      }),
    )
    await Effect.runPromise(
      service.ensureMilestoneComment(ISSUE_UUID, marker, mixedBody),
    )
    await Effect.runPromise(
      service.ensureMilestoneComment(ISSUE_UUID, marker, mixedBody),
    )
    expect(linearMilestoneMarker("work-started", "wi-1")).toBe(marker)
    expect(linearMilestoneMarker("completion", "wi-1")).toBe(
      "ready-for-agent:completion:wi-1",
    )
    expect(marker.startsWith("<!--")).toBe(false)
    expect(comments.nodes).toHaveLength(1)
    expect(comments.nodes[0]?.body).toContain(marker)
    expect(comments.nodes[0]?.body).not.toContain("<!--")
    expect(operations.filter((operation) => operation === "create")).toEqual([
      "create",
    ])
  })
})
