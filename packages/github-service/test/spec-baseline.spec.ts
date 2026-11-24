import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { renderSpecBaseline } from "@ready-for-agent/forge-contract"
import { makeGitHubServiceFromToken } from "../src/lib/github-service-live.js"

const repository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}
const issueUrl = "https://github.com/acme/widgets/issues/1"
const page = <A>(nodes: readonly A[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
})
const issueResponse = (issue: object) =>
  Response.json({ data: { repository: { issue } } })
const original = {
  title: "Hosted MCP",
  body: "Expose MCP both locally and when deployed.",
  designRevisions: [
    `https://github.com/acme/widgets/blob/${"a".repeat(40)}/design.md`,
  ],
}

it.live("finds a published GitHub Spec baseline on a later comment page", () =>
  Effect.gen(function* () {
    const snapshotUrl = `${issueUrl}#issuecomment-10`
    const service = makeGitHubServiceFromToken("token", async (_, init) => {
      const request = String(init?.body)
      if (!request.includes("comments")) {
        return issueResponse({
          title: "Local MCP",
          body: `Expose MCP locally.\n\n[Approved Spec baseline](<${snapshotUrl}>)`,
          url: issueUrl,
          labels: page([{ name: "Spec" }, { name: "ready-for-agent" }]),
        })
      }
      expect(request).toContain("lastEditedAt")
      return request.includes("next-comments")
        ? issueResponse({
            comments: page([
              {
                body: renderSpecBaseline(original),
                url: snapshotUrl,
                lastEditedAt: null,
              },
            ]),
          })
        : issueResponse({
            comments: page(
              [
                {
                  body: "Agent: deployment is outside this slice.",
                  url: `${issueUrl}#issuecomment-9`,
                  lastEditedAt: null,
                },
              ],
              "next-comments",
            ),
          })
    })
    expect(yield* service.readSpecBaseline(repository, 1)).toEqual({
      kind: "baseline",
      baseline: {
        ...original,
        source: { kind: "publication-comment", url: snapshotUrl },
      },
    })
  }),
)

it.live(
  "does not offer a marked, Ready-labeled GitHub Spec before it has children",
  () =>
    Effect.gen(function* () {
      const issue = (number: number, hasChildren: boolean) => ({
        number,
        title: `Issue ${number}`,
        body: "",
        url: `https://github.com/acme/widgets/issues/${number}`,
        createdAt: "2026-11-24T00:00:00Z",
        state: "OPEN",
        labels: page(
          [{ name: "ready-for-agent" }],
          number === 1 ? "next-labels" : null,
        ),
        parent: null,
        subIssuesSummary: { total: hasChildren ? 1 : 0 },
        subIssues: page([]),
        blockedBy: page([]),
        closedByPullRequestsReferences: page([]),
      })
      const service = makeGitHubServiceFromToken("token", async (_, init) =>
        String(init?.body).includes("next-labels")
          ? issueResponse({ labels: page([{ name: "Spec" }]) })
          : Response.json({
              data: {
                repository: {
                  issues: page([
                    issue(1, false),
                    issue(2, true),
                    issue(3, false),
                  ]),
                },
              },
            }),
      )
      expect(
        (yield* service.listReadyIssues(repository)).map(
          ({ number, hasChildren }) => ({ number, hasChildren }),
        ),
      ).toEqual([
        { number: 2, hasChildren: true },
        { number: 3, hasChildren: false },
      ])
    }),
)

it.live("does not infer a GitHub Spec from planning text", () =>
  Effect.gen(function* () {
    const service = makeGitHubServiceFromToken("token", async (_, init) => {
      expect(String(init?.body)).not.toContain("comments")
      return issueResponse({
        title: original.title,
        body: original.body,
        url: issueUrl,
        labels: page([{ name: "ready-for-agent" }]),
      })
    })
    expect(yield* service.readSpecBaseline(repository, 1)).toEqual({
      kind: "not-spec",
    })
  }),
)
