import { Effect } from "effect"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import {
  GITLAB_CI_GATE_KIND,
  GitLabRequestError,
  makeGitLabServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
}

const projectPayload = (input: {
  readonly id?: number
  readonly ciConfigPath?: string | null
  readonly buildsAccessLevel?: string
  readonly jobsEnabled?: boolean
}) => ({
  id: input.id ?? 42,
  path_with_namespace: "project/oauth_client",
  default_branch: "main",
  web_url: "https://git.drupalcode.org/project/oauth_client",
  ci_config_path: input.ciConfigPath,
  builds_access_level: input.buildsAccessLevel ?? "enabled",
  jobs_enabled: input.jobsEnabled ?? true,
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : status === 403 ? "Forbidden" : "Error",
    headers: { "content-type": "application/json" },
  })

const isProjectUrl = (url: URL) =>
  url.pathname === "/api/v4/projects/project%2Foauth_client"

describe("GitLab CI Gate catalog", () => {
  test("returns exactly one synthesized Project pipeline when project CI is available", async () => {
    const requested: string[] = []
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      requested.push(`${url.pathname}${url.search}`)
      if (!isProjectUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      return jsonResponse(
        projectPayload({ ciConfigPath: null, buildsAccessLevel: "private" }),
      )
    }) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "42",
        displayLabel: "Project pipeline",
        kind: GITLAB_CI_GATE_KIND,
        diagnosticMetadata: ".gitlab-ci.yml",
      },
    ])
    expect(requested.every((path) => !path.includes("/pipelines"))).toBe(true)
    expect(requested.every((path) => !path.includes("/jobs"))).toBe(true)
  })

  test("uses the last-known custom CI configuration path as display metadata", async () => {
    const service = makeGitLabServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (!isProjectUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      return jsonResponse(
        projectPayload({
          ciConfigPath: "ci/custom.yml@group/ci-templates",
        }),
      )
    }) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "42",
        displayLabel: "Project pipeline",
        kind: GITLAB_CI_GATE_KIND,
        diagnosticMetadata: "ci/custom.yml@group/ci-templates",
      },
    ])
  })

  test("omits the synthesized definition when project CI is disabled", async () => {
    const service = makeGitLabServiceFromToken("token", (async () =>
      jsonResponse(
        projectPayload({ buildsAccessLevel: "disabled" }),
      )) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([])
  })

  test("fails when project CI is available but GitLab omits a project id", async () => {
    const service = makeGitLabServiceFromToken("token", (async () =>
      jsonResponse({
        path_with_namespace: "project/oauth_client",
        default_branch: "main",
        web_url: "https://git.drupalcode.org/project/oauth_client",
        builds_access_level: "enabled",
        jobs_enabled: true,
      })) as typeof fetch)

    const error = await Effect.runPromise(
      service.listCiGateCatalog(repository).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.message).toContain("no project id")
  })

  test("omits the synthesized definition when jobs are disabled", async () => {
    const service = makeGitLabServiceFromToken("token", (async () =>
      jsonResponse(
        projectPayload({ jobsEnabled: false, buildsAccessLevel: "enabled" }),
      )) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([])
  })

  test("maps a permission 403 to an actionable catalog error without GitLab body text", async () => {
    const service = makeGitLabServiceFromToken("token", (async () =>
      jsonResponse(
        { message: "403 Forbidden — insufficient_scope" },
        403,
      )) as typeof fetch)

    const error = await Effect.runPromise(
      service.listCiGateCatalog(repository).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.statusCode).toBe(403)
    expect(error.message).toContain("API/pipeline read required")
    expect(error.message).not.toContain("insufficient_scope")
    expect(formatUserFacingError(error)).not.toContain("insufficient_scope")
  })
})
