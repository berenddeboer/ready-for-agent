import { Effect, Result } from "effect"
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
