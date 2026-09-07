import { Effect } from "effect"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import { GitLabRequestError, makeGitLabServiceFromToken } from "../src/index.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
}

const projectPayload = {
  id: 42,
  path_with_namespace: "project/oauth_client",
  default_branch: "main",
  web_url: "https://git.drupalcode.org/project/oauth_client",
  ci_config_path: ".gitlab-ci.yml",
  builds_access_level: "enabled",
  jobs_enabled: true,
}

const pipelinePayload = (input: {
  readonly id: number
  readonly iid?: number
  readonly source: string
  readonly status: string
  readonly ref?: string
  readonly sha?: string
  readonly name?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly startedAt?: string
  readonly webUrl?: string
}) => ({
  id: input.id,
  iid: input.iid ?? input.id,
  project_id: 42,
  status: input.status,
  source: input.source,
  ref: input.ref ?? "main",
  sha: input.sha ?? `sha-${String(input.id)}`,
  name: input.name ?? "Build pipeline",
  web_url:
    input.webUrl ??
    `https://git.drupalcode.org/project/oauth_client/-/pipelines/${String(input.id)}`,
  created_at: input.createdAt ?? "2026-09-07T10:00:00.085Z",
  updated_at: input.updatedAt ?? "2026-09-07T10:05:00.169Z",
  started_at: input.startedAt ?? "2026-09-07T10:00:01.000Z",
})

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : status === 403 ? "Forbidden" : "Error",
    headers: { "content-type": "application/json", ...headers },
  })

const isProjectUrl = (url: URL) =>
  url.pathname === "/api/v4/projects/project%2Foauth_client"

const isPipelinesUrl = (url: URL) =>
  url.pathname === "/api/v4/projects/project%2Foauth_client/pipelines"

describe("GitLab CI Gate observation", () => {
  test("returns default-branch push, schedule, web, trigger, and api pipelines in provider order", async () => {
    const requested: string[] = []
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      requested.push(url.pathname)
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      if (!isPipelinesUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("ref")).toBe("main")
      expect(url.searchParams.get("order_by")).toBe("id")
      expect(url.searchParams.get("sort")).toBe("desc")
      expect(url.searchParams.get("source")).not.toBe("parent_pipeline")
      return jsonResponse([
        pipelinePayload({
          id: 600,
          iid: 60,
          source: "web",
          status: "success",
          createdAt: "2026-09-07T12:00:00.000Z",
        }),
        pipelinePayload({
          id: 500,
          iid: 50,
          source: "api",
          status: "running",
          createdAt: "2026-09-07T11:30:00.000Z",
        }),
        pipelinePayload({
          id: 400,
          iid: 40,
          source: "trigger",
          status: "failed",
          createdAt: "2026-09-07T11:00:00.000Z",
        }),
        pipelinePayload({
          id: 350,
          iid: 35,
          source: "schedule",
          status: "success",
          createdAt: "2026-09-07T10:45:00.000Z",
        }),
        pipelinePayload({
          id: 300,
          iid: 30,
          source: "merge_request_event",
          status: "failed",
          createdAt: "2026-09-07T10:40:00.000Z",
        }),
        pipelinePayload({
          id: 250,
          iid: 25,
          source: "push",
          status: "failed",
          ref: "feature",
          createdAt: "2026-09-07T10:30:00.000Z",
        }),
        pipelinePayload({
          id: 200,
          iid: 20,
          source: "parent_pipeline",
          status: "failed",
          createdAt: "2026-09-07T10:20:00.000Z",
        }),
        pipelinePayload({
          id: 100,
          iid: 10,
          source: "push",
          status: "failed",
          createdAt: "2026-09-07T10:00:00.000Z",
        }),
      ])
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42"],
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
    expect(definition.identity).toBe("42")
    expect(definition.runs.map((run) => run.runIdentity)).toEqual([
      "600:60",
      "500:50",
      "400:40",
      "350:35",
      "100:10",
    ])
    expect(definition.runs[0]).toEqual({
      runIdentity: "600:60",
      htmlUrl:
        "https://git.drupalcode.org/project/oauth_client/-/pipelines/600",
      headSha: "sha-600",
      headRef: "main",
      event: "web",
      createdAt: new Date("2026-09-07T12:00:00.000Z"),
      updatedAt: new Date("2026-09-07T10:05:00.169Z"),
      startedAt: new Date("2026-09-07T10:00:01.000Z"),
      rawStatus: "success",
      rawConclusion: null,
    })
    expect(definition.runs[1]?.rawStatus).toBe("running")
    expect(definition.runs[2]?.rawStatus).toBe("failed")
    expect(definition.runs[2]?.event).toBe("trigger")
    expect(requested.some((path) => path.includes("/jobs"))).toBe(false)
    expect(requested.some((path) => path.includes("/bridges"))).toBe(false)
  })

  test("includes every relevant pipeline across paginated official API pages", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      pipelinePayload({
        id: 1000 - index,
        iid: 1000 - index,
        source: "push",
        status: "success",
        createdAt: `2026-09-07T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }),
    )
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      if (!isPipelinesUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      if (page === "1") {
        return jsonResponse(pageOne, 200, { "x-next-page": "2" })
      }
      if (page === "2") {
        return jsonResponse([
          pipelinePayload({
            id: 1,
            iid: 1,
            source: "push",
            status: "failed",
            createdAt: "2026-09-06T09:00:00.000Z",
          }),
        ])
      }
      return jsonResponse([])
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42"],
        lastRunIdentities: {},
      }),
    )
    const definition = observation.observations[0]
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs).toHaveLength(101)
    expect(definition.runs[0]?.runIdentity).toBe("1000:1000")
    expect(definition.runs[100]?.runIdentity).toBe("1:1")
    expect(definition.runs[100]?.rawStatus).toBe("failed")
  })

  test("stops paging once the last-seen pipeline identity is included", async () => {
    const requestedPages: string[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      pipelinePayload({
        id: 2000 - index,
        iid: 2000 - index,
        source: "push",
        status: "success",
      }),
    )
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      if (!isPipelinesUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      const page = url.searchParams.get("page") ?? "1"
      requestedPages.push(page)
      if (page === "1") {
        return jsonResponse(pageOne, 200, { "x-next-page": "2" })
      }
      throw new Error(`unexpected extra page ${page}`)
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42"],
        lastRunIdentities: { "42": "1950:1950" },
      }),
    )
    const definition = observation.observations[0]
    expect(requestedPages).toEqual(["1"])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs[0]?.runIdentity).toBe("2000:2000")
    expect(definition.runs.at(-1)?.runIdentity).toBe("1950:1950")
    expect(definition.runs).toHaveLength(51)
  })

  test("marks disabled project CI unavailable without listing pipeline history", async () => {
    const requested: string[] = []
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      requested.push(url.pathname)
      if (isProjectUrl(url)) {
        return jsonResponse({
          ...projectPayload,
          builds_access_level: "disabled",
        })
      }
      throw new Error(`unexpected request ${url.pathname}`)
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.observations).toEqual([
      {
        identity: "42",
        kind: "unavailable",
        reason: "not_found",
        message: expect.stringContaining("disabled"),
      },
    ])
    expect(requested.some((path) => path.includes("/pipelines"))).toBe(false)
  })

  test("fails when project CI is available but GitLab omits a project id", async () => {
    const requested: string[] = []
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      requested.push(url.pathname)
      if (isProjectUrl(url)) {
        const { id: _id, ...withoutId } = projectPayload
        return jsonResponse(withoutId)
      }
      throw new Error(`unexpected request ${url.pathname}`)
    }) as typeof fetch)

    const error = await Effect.runPromise(
      service
        .observeCiGate(repository, {
          definitionIdentities: ["42"],
          lastRunIdentities: {},
        })
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.message).toContain("no project id")
    expect(requested.some((path) => path.includes("/pipelines"))).toBe(false)
  })

  test("marks a stale identity unavailable and still observes the live Project pipeline", async () => {
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      if (isPipelinesUrl(url)) {
        return jsonResponse([
          pipelinePayload({
            id: 47,
            iid: 12,
            source: "push",
            status: "success",
          }),
        ])
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42", "999"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.observations).toEqual([
      expect.objectContaining({
        identity: "42",
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
      expect(live.runs[0]?.runIdentity).toBe("47:12")
      expect(live.runs[0]?.htmlUrl).toBe(
        "https://git.drupalcode.org/project/oauth_client/-/pipelines/47",
      )
    }
  })

  test("treats deleted pipeline history as an empty observation rather than a failure", async () => {
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      if (isPipelinesUrl(url)) {
        return jsonResponse([])
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["42"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.observations).toEqual([
      { identity: "42", kind: "observed", runs: [] },
    ])
  })

  test("maps a permission 403 to an actionable observation error without GitLab body text", async () => {
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isProjectUrl(url)) {
        return jsonResponse(projectPayload)
      }
      return jsonResponse(
        { message: "403 Forbidden — read_api is required" },
        403,
      )
    }) as typeof fetch)

    const error = await Effect.runPromise(
      service
        .observeCiGate(repository, {
          definitionIdentities: ["42"],
          lastRunIdentities: {},
        })
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.statusCode).toBe(403)
    expect(error.message).toContain("API/pipeline read required")
    expect(error.message).not.toContain("read_api is required")
    expect(formatUserFacingError(error)).not.toContain("read_api is required")
  })
})
