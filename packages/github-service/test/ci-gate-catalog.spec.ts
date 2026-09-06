import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  GITHUB_CI_GATE_KIND,
  GitHubRequestError,
  GitHubThrottledError,
  formatUserFacingError,
  makeGitHubServiceFromToken,
} from "../src/index.js"

const repository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

const workflowPayload = (input: {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly state: string
}) => ({
  id: input.id,
  node_id: `W_${String(input.id)}`,
  name: input.name,
  path: input.path,
  state: input.state,
  created_at: "2020-01-08T23:48:37.000-08:00",
  updated_at: "2020-01-08T23:50:21.000-08:00",
  url: `https://api.github.com/repos/acme/widgets/actions/workflows/${String(input.id)}`,
  html_url: `https://github.com/acme/widgets/blob/master/${input.path}`,
  badge_url: `https://github.com/acme/widgets/workflows/${input.name}/badge.svg`,
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Forbidden",
    headers: { "content-type": "application/json" },
  })

describe("GitHub CI Gate catalog", () => {
  it("returns active workflows as catalog entries and omits inactive ones", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (!url.includes("/actions/workflows")) {
        return new Response("not found", { status: 404 })
      }
      return jsonResponse({
        total_count: 4,
        workflows: [
          workflowPayload({
            id: 161335,
            name: "CI",
            path: ".github/workflows/blank.yaml",
            state: "active",
          }),
          workflowPayload({
            id: 269289,
            name: "Linter",
            path: ".github/workflows/linter.yaml",
            state: "disabled_manually",
          }),
          workflowPayload({
            id: 314159,
            name: "Nightly",
            path: ".github/workflows/nightly.yml",
            state: "disabled_inactivity",
          }),
          workflowPayload({
            id: 271828,
            name: "Retired",
            path: ".github/workflows/retired.yml",
            state: "deleted",
          }),
        ],
      })
    })

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "161335",
        displayLabel: "CI",
        kind: GITHUB_CI_GATE_KIND,
        diagnosticMetadata: ".github/workflows/blank.yaml",
      },
    ])
  })

  it("includes every active workflow across paginated official API pages", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      workflowPayload({
        id: index + 1,
        name: `Workflow ${String(index + 1)}`,
        path: `.github/workflows/w${String(index + 1)}.yml`,
        state: "active",
      }),
    )
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith("/actions/workflows")) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      if (page === "1") {
        return jsonResponse({ total_count: 101, workflows: pageOne })
      }
      if (page === "2") {
        return jsonResponse({
          total_count: 101,
          workflows: [
            workflowPayload({
              id: 9001,
              name: "Release",
              path: ".github/workflows/release.yml",
              state: "active",
            }),
          ],
        })
      }
      return jsonResponse({ total_count: 101, workflows: [] })
    })

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toHaveLength(101)
    expect(catalog[0]).toEqual({
      identity: "1",
      displayLabel: "Workflow 1",
      kind: GITHUB_CI_GATE_KIND,
      diagnosticMetadata: ".github/workflows/w1.yml",
    })
    expect(catalog[100]).toEqual({
      identity: "9001",
      displayLabel: "Release",
      kind: GITHUB_CI_GATE_KIND,
      diagnosticMetadata: ".github/workflows/release.yml",
    })
  })

  it("skips workflows that lack a stable identity or display label", async () => {
    const service = makeGitHubServiceFromToken("token", async () =>
      jsonResponse({
        total_count: 3,
        workflows: [
          {
            id: "not-a-number",
            name: "Broken",
            path: ".github/workflows/broken.yml",
            state: "active",
          },
          workflowPayload({
            id: 12,
            name: "   ",
            path: ".github/workflows/blank.yml",
            state: "active",
          }),
          workflowPayload({
            id: 42,
            name: "Build",
            path: ".github/workflows/build.yml",
            state: "active",
          }),
        ],
      }),
    )

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "42",
        displayLabel: "Build",
        kind: GITHUB_CI_GATE_KIND,
        diagnosticMetadata: ".github/workflows/build.yml",
      },
    ])
  })

  it.effect(
    "maps a permission 403 to an actionable catalog error without GitHub body text",
    () =>
      Effect.gen(function* () {
        const service = makeGitHubServiceFromToken(
          "token",
          async () =>
            new Response(
              JSON.stringify({
                message: "Resource not accessible by personal access token",
                documentation_url:
                  "https://docs.github.com/rest/actions/workflows",
              }),
              {
                status: 403,
                statusText: "Forbidden",
                headers: {
                  "content-type": "application/json",
                  "X-Accepted-GitHub-Permissions": "actions=read",
                },
              },
            ),
        )

        const error = yield* service
          .listCiGateCatalog(repository)
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect(error.statusCode).toBe(403)
        expect(error.retryable).toBe(false)
        expect(error.message).toContain("Actions read required")
        expect(error.message).not.toContain(
          "Resource not accessible by personal access token",
        )
        expect(formatUserFacingError(error)).not.toContain(
          "Resource not accessible by personal access token",
        )
      }),
  )

  it.effect("keeps a throttled 403 as GitHub throttling", () =>
    Effect.gen(function* () {
      const resetSeconds = Math.floor(Date.now() / 1_000) + 90
      const service = makeGitHubServiceFromToken(
        "token",
        async () =>
          new Response("API rate limit exceeded", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetSeconds),
            },
          }),
      )

      const error = yield* service
        .listCiGateCatalog(repository)
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitHubThrottledError)
      expect(error.retryAt).toBe(resetSeconds * 1_000)
    }),
  )
})
