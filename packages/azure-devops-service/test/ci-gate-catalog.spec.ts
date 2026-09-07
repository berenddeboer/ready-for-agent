import { Effect, Result } from "effect"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import {
  AZURE_DEVOPS_CI_GATE_KIND,
  AzureDevOpsRequestError,
  makeAzureDevOpsServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

const REPOSITORY_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"
const OTHER_REPOSITORY_ID = "cccccccc-4444-5555-6666-dddddddddddd"

const json = (
  value: unknown,
  init: { readonly status?: number; readonly continuationToken?: string } = {},
): Response => {
  const headers = new Headers({ "content-type": "application/json" })
  if (init.continuationToken !== undefined) {
    headers.set("x-ms-continuationtoken", init.continuationToken)
  }
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    statusText: init.status === 403 ? "Forbidden" : "OK",
    headers,
  })
}

const definitionPayload = (input: {
  readonly id: number
  readonly name: string
  readonly path?: string
  readonly queueStatus?: string
  readonly revision?: number
  readonly quality?: string
  readonly type?: string
  readonly repositoryId?: string
}) => ({
  id: input.id,
  name: input.name,
  path: input.path ?? "\\",
  type: input.type ?? "build",
  queueStatus: input.queueStatus ?? "enabled",
  revision: input.revision ?? 1,
  quality: input.quality ?? "definition",
  uri: `vstfs:///Build/Definition/${String(input.id)}`,
  url: `https://dev.azure.com/acme/widgets/_apis/build/definitions/${String(input.id)}`,
  _links: {
    web: {
      href: `https://dev.azure.com/acme/widgets/_build?definitionId=${String(input.id)}`,
    },
  },
  repository: {
    id: input.repositoryId ?? REPOSITORY_ID,
    type: "TfsGit",
    name: "widgets",
  },
})

const isRepositoryMetaUrl = (url: URL): boolean =>
  url.pathname === "/acme/widgets/_apis/git/repositories/widgets"

const isDefinitionsListUrl = (url: URL): boolean =>
  url.pathname === "/acme/widgets/_apis/build/definitions"

describe("Azure DevOps CI Gate catalog", () => {
  test("lists enabled build pipelines for the configured Git Repository only", async () => {
    const requested: URL[] = []
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      requested.push(url)
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (!isDefinitionsListUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("repositoryId")).toBe(REPOSITORY_ID)
      expect(url.searchParams.get("repositoryType")).toBe("TfsGit")
      expect(url.searchParams.get("page")).toBeNull()
      return json({
        count: 5,
        value: [
          definitionPayload({
            id: 12,
            name: "CI",
            path: "\\CI",
            revision: 3,
          }),
          definitionPayload({
            id: 13,
            name: "Nightly",
            path: "\\Nightly",
            queueStatus: "paused",
            revision: 8,
          }),
          definitionPayload({
            id: 14,
            name: "Retired",
            path: "\\Archive",
            queueStatus: "disabled",
            revision: 2,
          }),
          definitionPayload({
            id: 15,
            name: "Other repo",
            path: "\\Shared",
            repositoryId: OTHER_REPOSITORY_ID,
          }),
          definitionPayload({
            id: 16,
            name: "Draft pipeline",
            quality: "draft",
          }),
        ],
      })
    }) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "12",
        displayLabel: "CI",
        kind: AZURE_DEVOPS_CI_GATE_KIND,
        diagnosticMetadata:
          "\\CI · build · enabled · rev 3 · https://dev.azure.com/acme/widgets/_build?definitionId=12",
      },
    ])
    expect(requested.some((url) => isDefinitionsListUrl(url))).toBe(true)
  })

  test("follows continuation-token pages instead of GitHub-style page numbers", async () => {
    const continuationTokens: Array<string | null> = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      definitionPayload({
        id: index + 1,
        name: `Pipeline ${String(index + 1)}`,
        path: `\\Batch\\${String(index + 1)}`,
      }),
    )
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (!isDefinitionsListUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("page")).toBeNull()
      continuationTokens.push(url.searchParams.get("continuationToken"))
      if (url.searchParams.get("continuationToken") === null) {
        return json({ value: pageOne }, { continuationToken: "page-2" })
      }
      if (url.searchParams.get("continuationToken") === "page-2") {
        return json({
          value: [
            definitionPayload({
              id: 9001,
              name: "Release",
              path: "\\Release",
              revision: 11,
            }),
          ],
        })
      }
      throw new Error(`unexpected continuation ${url.search}`)
    }) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(continuationTokens).toEqual([null, "page-2"])
    expect(catalog).toHaveLength(101)
    expect(catalog[0]).toEqual({
      identity: "1",
      displayLabel: "Pipeline 1",
      kind: AZURE_DEVOPS_CI_GATE_KIND,
      diagnosticMetadata:
        "\\Batch\\1 · build · enabled · rev 1 · https://dev.azure.com/acme/widgets/_build?definitionId=1",
    })
    expect(catalog[100]).toEqual({
      identity: "9001",
      displayLabel: "Release",
      kind: AZURE_DEVOPS_CI_GATE_KIND,
      diagnosticMetadata:
        "\\Release · build · enabled · rev 11 · https://dev.azure.com/acme/widgets/_build?definitionId=9001",
    })
  })

  test("skips definitions that lack a stable identity or display name", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      return json({
        value: [
          {
            id: "not-a-number",
            name: "Broken",
            path: "\\Broken",
            queueStatus: "enabled",
            repository: { id: REPOSITORY_ID, type: "TfsGit" },
          },
          definitionPayload({
            id: 12,
            name: "   ",
            path: "\\Blank",
          }),
          definitionPayload({
            id: 42,
            name: "Build",
            path: "\\Build",
            revision: 4,
            type: "xaml",
          }),
        ],
      })
    }) as typeof fetch)

    const catalog = await Effect.runPromise(
      service.listCiGateCatalog(repository),
    )

    expect(catalog).toEqual([
      {
        identity: "42",
        displayLabel: "Build",
        kind: AZURE_DEVOPS_CI_GATE_KIND,
        diagnosticMetadata:
          "\\Build · xaml · enabled · rev 4 · https://dev.azure.com/acme/widgets/_build?definitionId=42",
      },
    ])
  })

  test("maps a permission 403 to Build-read guidance without Azure body text", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      return new Response(
        JSON.stringify({
          message: "TF401444: The user lacks permission to read builds.",
        }),
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "application/json" },
        },
      )
    }) as typeof fetch)

    const error = await Effect.runPromise(
      service.listCiGateCatalog(repository).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
    expect(error.statusCode).toBe(403)
    expect(error.message).toContain("Build read required")
    expect(error.message).not.toContain("TF401444")
    expect(formatUserFacingError(error)).not.toContain("TF401444")
  })

  test("fails closed when the Git repository metadata cannot be resolved", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({ defaultBranch: "refs/heads/main" })
      }
      throw new Error("must not list definitions without a repository id")
    }) as typeof fetch)

    const result = await Effect.runPromise(
      service.listCiGateCatalog(repository).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
  })
})
