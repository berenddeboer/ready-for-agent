import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
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
const current = {
  title: "Hosted MCP",
  body: "Expose MCP both locally and when deployed.",
  url: issueUrl,
}

it.live(
  "reads a marked GitHub Spec directly as written without reading comments",
  () =>
    Effect.gen(function* () {
      const service = makeGitHubServiceFromToken("token", async (_, init) => {
        expect(String(init?.body)).not.toContain("comments")
        return issueResponse({
          ...current,
          labels: page([{ name: "Spec" }, { name: "ready-for-agent" }]),
        })
      })
      expect(yield* service.readSpecBaseline(repository, 1)).toEqual({
        kind: "baseline",
        baseline: current,
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
        ...current,
        labels: page([{ name: "ready-for-agent" }]),
      })
    })
    expect(yield* service.readSpecBaseline(repository, 1)).toEqual({
      kind: "not-spec",
    })
  }),
)
