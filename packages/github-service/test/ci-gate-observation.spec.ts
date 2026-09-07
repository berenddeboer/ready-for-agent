import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
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

const repoPayload = { default_branch: "main" }

const workflowRunPayload = (input: {
  readonly id: number
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
  readonly headBranch?: string
  readonly headSha?: string
  readonly htmlUrl?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly startedAt?: string
  readonly runAttempt?: number
}) => ({
  id: input.id,
  name: "CI",
  head_branch: input.headBranch ?? "main",
  head_sha: input.headSha ?? `sha-${String(input.id)}`,
  path: ".github/workflows/ci.yml",
  display_title: "CI",
  run_number: input.id,
  event: input.event,
  status: input.status,
  conclusion: input.conclusion,
  workflow_id: 161335,
  html_url:
    input.htmlUrl ??
    `https://github.com/acme/widgets/actions/runs/${String(input.id)}`,
  created_at: input.createdAt ?? "2026-09-07T10:00:00Z",
  updated_at: input.updatedAt ?? "2026-09-07T10:05:00Z",
  run_attempt: input.runAttempt ?? 1,
  run_started_at: input.startedAt ?? "2026-09-07T10:00:01Z",
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText:
      status === 200
        ? "OK"
        : status === 404
          ? "Not Found"
          : status === 403
            ? "Forbidden"
            : "Error",
    headers: { "content-type": "application/json" },
  })

const isRepoUrl = (url: URL) => url.pathname === "/repos/acme/widgets"

const isWorkflowRunsUrl = (url: URL, workflowId = "161335") =>
  url.pathname === `/repos/acme/widgets/actions/workflows/${workflowId}/runs`

describe("GitHub CI Gate observation", () => {
  it("returns default-branch push, schedule, dispatch, and rerun runs in provider order", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (isRepoUrl(url)) {
        return jsonResponse(repoPayload)
      }
      if (!isWorkflowRunsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("branch")).toBe("main")
      expect(url.searchParams.get("exclude_pull_requests")).toBe("true")
      return jsonResponse({
        total_count: 6,
        workflow_runs: [
          workflowRunPayload({
            id: 600,
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-09-07T12:00:00Z",
          }),
          workflowRunPayload({
            id: 500,
            event: "push",
            status: "in_progress",
            conclusion: null,
            runAttempt: 2,
            createdAt: "2026-09-07T11:30:00Z",
          }),
          workflowRunPayload({
            id: 400,
            event: "schedule",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-07T11:00:00Z",
          }),
          workflowRunPayload({
            id: 300,
            event: "pull_request",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-07T10:45:00Z",
          }),
          workflowRunPayload({
            id: 200,
            event: "push",
            status: "completed",
            conclusion: "failure",
            headBranch: "feature",
            createdAt: "2026-09-07T10:30:00Z",
          }),
          workflowRunPayload({
            id: 100,
            event: "pull_request_target",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-07T10:15:00Z",
          }),
        ],
      })
    })

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["161335"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.defaultBranch).toBe("main")
    expect(observation.observations).toHaveLength(1)
    const definition = observation.observations[0]
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs.map((run) => run.runIdentity)).toEqual([
      "600:1",
      "500:2",
      "400:1",
    ])
    expect(definition.runs[0]).toEqual({
      runIdentity: "600:1",
      htmlUrl: "https://github.com/acme/widgets/actions/runs/600",
      headSha: "sha-600",
      headRef: "main",
      event: "workflow_dispatch",
      createdAt: new Date("2026-09-07T12:00:00Z"),
      updatedAt: new Date("2026-09-07T10:05:00Z"),
      startedAt: new Date("2026-09-07T10:00:01Z"),
      rawStatus: "completed",
      rawConclusion: "success",
    })
    expect(definition.runs[1]?.rawStatus).toBe("in_progress")
    expect(definition.runs[1]?.rawConclusion).toBeNull()
    expect(definition.runs[2]?.rawConclusion).toBe("failure")
  })

  it("caps first observation to one official API page when last-seen is empty", async () => {
    const requestedPages: string[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      workflowRunPayload({
        id: 1000 - index,
        event: "push",
        status: "completed",
        conclusion: "success",
        createdAt: `2026-09-07T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
      }),
    )
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (isRepoUrl(url)) {
        return jsonResponse(repoPayload)
      }
      if (!isWorkflowRunsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      requestedPages.push(page)
      if (page === "1") {
        return jsonResponse({ total_count: 101, workflow_runs: pageOne })
      }
      throw new Error(`unexpected extra page ${page}`)
    })

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["161335"],
        lastRunIdentities: {},
      }),
    )
    const definition = observation.observations[0]
    expect(requestedPages).toEqual(["1"])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs).toHaveLength(100)
    expect(definition.runs[0]?.runIdentity).toBe("1000:1")
    expect(definition.runs.at(-1)?.runIdentity).toBe("901:1")
  })

  it("stops paging once the last-seen run identity is included", async () => {
    const requestedPages: string[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      workflowRunPayload({
        id: 2000 - index,
        event: "push",
        status: "completed",
        conclusion: "success",
      }),
    )
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (isRepoUrl(url)) {
        return jsonResponse(repoPayload)
      }
      if (!isWorkflowRunsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      requestedPages.push(page)
      if (page === "1") {
        return jsonResponse({ total_count: 200, workflow_runs: pageOne })
      }
      throw new Error(`unexpected extra page ${page}`)
    })

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["161335"],
        lastRunIdentities: { "161335": "1950:1" },
      }),
    )
    const definition = observation.observations[0]
    expect(requestedPages).toEqual(["1"])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs[0]?.runIdentity).toBe("2000:1")
    expect(definition.runs.at(-1)?.runIdentity).toBe("1950:1")
    expect(definition.runs).toHaveLength(51)
  })

  it("stops paging at the latest attempt of the last-seen run", async () => {
    const requestedPages: string[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      workflowRunPayload({
        id: 2000 - index,
        event: "push",
        status: "completed",
        conclusion: "success",
        runAttempt: 2000 - index === 1950 ? 2 : 1,
      }),
    )
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (isRepoUrl(url)) {
        return jsonResponse(repoPayload)
      }
      if (!isWorkflowRunsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      requestedPages.push(page)
      if (page === "1") {
        return jsonResponse({ total_count: 200, workflow_runs: pageOne })
      }
      throw new Error(`unexpected extra page ${page}`)
    })

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["161335"],
        lastRunIdentities: { "161335": "1950:1" },
      }),
    )
    const definition = observation.observations[0]
    expect(requestedPages).toEqual(["1"])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs.at(-1)?.runIdentity).toBe("1950:2")
    expect(definition.runs).toHaveLength(51)
  })

  it("marks a deleted workflow unavailable without dropping other selections", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = new URL(String(input))
      if (isRepoUrl(url)) {
        return jsonResponse(repoPayload)
      }
      if (isWorkflowRunsUrl(url, "161335")) {
        return jsonResponse({
          total_count: 1,
          workflow_runs: [
            workflowRunPayload({
              id: 42,
              event: "push",
              status: "completed",
              conclusion: "success",
            }),
          ],
        })
      }
      if (isWorkflowRunsUrl(url, "999")) {
        return jsonResponse({ message: "Not Found" }, 404)
      }
      return new Response("not found", { status: 404 })
    })

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["161335", "999"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.observations).toEqual([
      expect.objectContaining({
        identity: "161335",
        kind: "observed",
      }),
      {
        identity: "999",
        kind: "unavailable",
        reason: "not_found",
        message: expect.stringContaining("could not be observed"),
      },
    ])
    const live = observation.observations[0]
    expect(live?.kind).toBe("observed")
    if (live?.kind === "observed") {
      expect(live.runs[0]?.htmlUrl).toBe(
        "https://github.com/acme/widgets/actions/runs/42",
      )
    }
  })

  it.effect(
    "maps a permission 403 to an actionable observation error without GitHub body text",
    () =>
      Effect.gen(function* () {
        const service = makeGitHubServiceFromToken("token", async (input) => {
          const url = new URL(String(input))
          if (isRepoUrl(url)) {
            return jsonResponse(repoPayload)
          }
          return new Response(
            JSON.stringify({
              message: "Resource not accessible by personal access token",
              documentation_url:
                "https://docs.github.com/rest/actions/workflow-runs",
            }),
            {
              status: 403,
              statusText: "Forbidden",
              headers: {
                "content-type": "application/json",
                "X-Accepted-GitHub-Permissions": "actions=read",
              },
            },
          )
        })

        const error = yield* service
          .observeCiGate(repository, {
            definitionIdentities: ["161335"],
            lastRunIdentities: {},
          })
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
      const service = makeGitHubServiceFromToken("token", async (input) => {
        const url = new URL(String(input))
        if (isRepoUrl(url)) {
          return jsonResponse(repoPayload)
        }
        return new Response("API rate limit exceeded", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
          },
        })
      })

      const error = yield* service
        .observeCiGate(repository, {
          definitionIdentities: ["161335"],
          lastRunIdentities: {},
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitHubThrottledError)
      expect(error.retryAt).toBe(resetSeconds * 1_000)
    }),
  )
})
