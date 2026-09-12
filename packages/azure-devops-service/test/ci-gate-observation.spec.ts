import { Effect } from "effect"
import { formatUserFacingError } from "@ready-for-agent/forge-contract"
import {
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
    statusText:
      init.status === 403
        ? "Forbidden"
        : init.status === 404
          ? "Not Found"
          : "OK",
    headers,
  })
}

const definitionPayload = (input: {
  readonly id?: number
  readonly queueStatus?: string
  readonly name?: string
}) => ({
  id: input.id ?? 12,
  name: input.name ?? "CI",
  path: "\\CI",
  type: "build",
  queueStatus: input.queueStatus ?? "enabled",
  revision: 3,
  repository: { id: REPOSITORY_ID, type: "TfsGit", name: "widgets" },
  _links: {
    web: { href: "https://dev.azure.com/acme/widgets/_build?definitionId=12" },
  },
})

const buildPayload = (input: {
  readonly id: number
  readonly reason: string
  readonly status: string
  readonly result: string | null
  readonly sourceBranch?: string
  readonly sourceVersion?: string
  readonly buildNumber?: string
  readonly queueTime?: string
  readonly startTime?: string
  readonly finishTime?: string
}) => ({
  id: input.id,
  buildNumber: input.buildNumber ?? `20260907.${String(input.id)}`,
  status: input.status,
  result: input.result,
  queueTime: input.queueTime ?? "2026-09-07T12:00:00Z",
  startTime: input.startTime ?? "2026-09-07T12:00:01Z",
  finishTime: input.finishTime ?? "2026-09-07T12:05:00Z",
  reason: input.reason,
  sourceBranch: input.sourceBranch ?? "refs/heads/main",
  sourceVersion: input.sourceVersion ?? `sha-${String(input.id)}`,
  _links: {
    web: {
      href: `https://dev.azure.com/acme/widgets/_build/results?buildId=${String(input.id)}`,
    },
  },
})

const isRepositoryMetaUrl = (url: URL): boolean =>
  url.pathname === "/acme/widgets/_apis/git/repositories/widgets"

const isDefinitionUrl = (url: URL, definitionId = "12"): boolean =>
  url.pathname === `/acme/widgets/_apis/build/definitions/${definitionId}`

const isBuildsUrl = (url: URL): boolean =>
  url.pathname === "/acme/widgets/_apis/build/builds"

describe("Azure DevOps CI Gate observation", () => {
  test("returns default-branch CI builds in provider order and excludes PR validation", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (isDefinitionUrl(url)) {
        return json(definitionPayload({}))
      }
      if (!isBuildsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("definitions")).toBe("12")
      expect(url.searchParams.get("branchName")).toBe("refs/heads/main")
      expect(url.searchParams.get("queryOrder")).toBe("QueueTimeDescending")
      expect(url.searchParams.get("page")).toBeNull()
      return json({
        value: [
          buildPayload({
            id: 600,
            reason: "manual",
            status: "completed",
            result: "succeeded",
            queueTime: "2026-09-07T12:00:00Z",
          }),
          buildPayload({
            id: 500,
            reason: "individualCI",
            status: "inProgress",
            result: null,
            queueTime: "2026-09-07T11:30:00Z",
            finishTime: undefined,
          }),
          buildPayload({
            id: 400,
            reason: "schedule",
            status: "completed",
            result: "failed",
            queueTime: "2026-09-07T11:00:00Z",
          }),
          buildPayload({
            id: 350,
            reason: "pullRequest",
            status: "completed",
            result: "failed",
            queueTime: "2026-09-07T10:50:00Z",
          }),
          buildPayload({
            id: 300,
            reason: "individualCI",
            status: "completed",
            result: "failed",
            sourceBranch: "refs/heads/feature",
            queueTime: "2026-09-07T10:30:00Z",
          }),
          buildPayload({
            id: 200,
            reason: "userCreated",
            status: "completed",
            result: "partiallySucceeded",
            queueTime: "2026-09-07T10:00:00Z",
          }),
        ],
      })
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["12"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.defaultBranch).toBe("refs/heads/main")
    expect(observation.observations).toHaveLength(1)
    const definition = observation.observations[0]
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs.map((run) => run.runIdentity)).toEqual([
      "600:20260907.600",
      "500:20260907.500",
      "400:20260907.400",
      "200:20260907.200",
    ])
    expect(definition.runs[0]).toEqual({
      runIdentity: "600:20260907.600",
      htmlUrl: "https://dev.azure.com/acme/widgets/_build/results?buildId=600",
      headSha: "sha-600",
      headRef: "refs/heads/main",
      event: "manual",
      createdAt: new Date("2026-09-07T12:00:00Z"),
      updatedAt: new Date("2026-09-07T12:05:00Z"),
      startedAt: new Date("2026-09-07T12:00:01Z"),
      rawStatus: "completed",
      rawConclusion: "succeeded",
    })
    expect(definition.runs[1]?.rawStatus).toBe("inProgress")
    expect(definition.runs[1]?.rawConclusion).toBeNull()
    expect(definition.runs[2]?.rawConclusion).toBe("failed")
    expect(definition.runs[3]?.rawConclusion).toBe("partiallySucceeded")
  })

  test("preserves canceled, notStarted, postponed, cancelling, and none raw outcomes", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (isDefinitionUrl(url)) {
        return json(definitionPayload({}))
      }
      if (!isBuildsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      return json({
        value: [
          buildPayload({
            id: 80,
            reason: "manual",
            status: "completed",
            result: "canceled",
            queueTime: "2026-09-07T12:00:00Z",
          }),
          buildPayload({
            id: 70,
            reason: "individualCI",
            status: "notStarted",
            result: "none",
            queueTime: "2026-09-07T11:50:00Z",
          }),
          buildPayload({
            id: 60,
            reason: "schedule",
            status: "postponed",
            result: null,
            queueTime: "2026-09-07T11:40:00Z",
          }),
          buildPayload({
            id: 50,
            reason: "manual",
            status: "cancelling",
            result: null,
            queueTime: "2026-09-07T11:30:00Z",
          }),
          buildPayload({
            id: 40,
            reason: "individualCI",
            status: "none",
            result: "none",
            queueTime: "2026-09-07T11:20:00Z",
          }),
        ],
      })
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["12"],
        lastRunIdentities: {},
      }),
    )
    const definition = observation.observations[0]
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(
      definition.runs.map((run) => ({
        runIdentity: run.runIdentity,
        rawStatus: run.rawStatus,
        rawConclusion: run.rawConclusion,
      })),
    ).toEqual([
      {
        runIdentity: "80:20260907.80",
        rawStatus: "completed",
        rawConclusion: "canceled",
      },
      {
        runIdentity: "70:20260907.70",
        rawStatus: "notStarted",
        rawConclusion: "none",
      },
      {
        runIdentity: "60:20260907.60",
        rawStatus: "postponed",
        rawConclusion: null,
      },
      {
        runIdentity: "50:20260907.50",
        rawStatus: "cancelling",
        rawConclusion: null,
      },
      {
        runIdentity: "40:20260907.40",
        rawStatus: "none",
        rawConclusion: "none",
      },
    ])
  })

  test("caps first observation to one continuation-token page when last-seen is empty", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      buildPayload({
        id: 1000 - index,
        reason: "individualCI",
        status: "completed",
        result: "succeeded",
        queueTime: `2026-09-07T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
      }),
    )
    const continuationTokens: Array<string | null> = []
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (isDefinitionUrl(url)) {
        return json(definitionPayload({}))
      }
      if (!isBuildsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      expect(url.searchParams.get("page")).toBeNull()
      continuationTokens.push(url.searchParams.get("continuationToken"))
      if (url.searchParams.get("continuationToken") === null) {
        return json({ value: pageOne }, { continuationToken: "builds-2" })
      }
      throw new Error(`unexpected extra page ${url.search}`)
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["12"],
        lastRunIdentities: {},
      }),
    )
    const definition = observation.observations[0]
    expect(continuationTokens).toEqual([null])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs).toHaveLength(100)
    expect(definition.runs[0]?.runIdentity).toBe("1000:20260907.1000")
    expect(definition.runs.at(-1)?.runIdentity).toBe("901:20260907.901")
  })

  test("stops paging once the last-seen build identity is included", async () => {
    const requestedTokens: Array<string | null> = []
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      buildPayload({
        id: 2000 - index,
        reason: "individualCI",
        status: "completed",
        result: "succeeded",
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
      if (isDefinitionUrl(url)) {
        return json(definitionPayload({}))
      }
      if (!isBuildsUrl(url)) {
        return new Response("not found", { status: 404 })
      }
      requestedTokens.push(url.searchParams.get("continuationToken"))
      if (url.searchParams.get("continuationToken") === null) {
        return json(
          { value: pageOne },
          { continuationToken: "should-not-fetch" },
        )
      }
      throw new Error(`unexpected extra page ${url.search}`)
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["12"],
        lastRunIdentities: { "12": "1950:20260907.1950" },
      }),
    )
    const definition = observation.observations[0]
    expect(requestedTokens).toEqual([null])
    expect(definition?.kind).toBe("observed")
    if (definition?.kind !== "observed") {
      throw new Error("expected observed definition")
    }
    expect(definition.runs[0]?.runIdentity).toBe("2000:20260907.2000")
    expect(definition.runs.at(-1)?.runIdentity).toBe("1950:20260907.1950")
    expect(definition.runs).toHaveLength(51)
  })

  test("marks deleted, disabled, and paused definitions unavailable without dropping others", async () => {
    const service = makeAzureDevOpsServiceFromToken("token", (async (input) => {
      const url = new URL(String(input))
      if (isRepositoryMetaUrl(url)) {
        return json({
          id: REPOSITORY_ID,
          defaultBranch: "refs/heads/main",
        })
      }
      if (isDefinitionUrl(url, "12")) {
        return json(definitionPayload({ id: 12, queueStatus: "enabled" }))
      }
      if (isDefinitionUrl(url, "13")) {
        return json(definitionPayload({ id: 13, queueStatus: "disabled" }))
      }
      if (isDefinitionUrl(url, "14")) {
        return json(definitionPayload({ id: 14, queueStatus: "paused" }))
      }
      if (isDefinitionUrl(url, "99")) {
        return json({ message: "Not found" }, { status: 404 })
      }
      if (isBuildsUrl(url) && url.searchParams.get("definitions") === "12") {
        return json({
          value: [
            buildPayload({
              id: 42,
              reason: "individualCI",
              status: "completed",
              result: "succeeded",
            }),
          ],
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch)

    const observation = await Effect.runPromise(
      service.observeCiGate(repository, {
        definitionIdentities: ["12", "13", "14", "99"],
        lastRunIdentities: {},
      }),
    )

    expect(observation.observations).toEqual([
      expect.objectContaining({
        identity: "12",
        kind: "observed",
      }),
      {
        identity: "13",
        kind: "unavailable",
        reason: "error",
        message: expect.stringContaining("disabled"),
      },
      {
        identity: "14",
        kind: "unavailable",
        reason: "error",
        message: expect.stringContaining("paused"),
      },
      {
        identity: "99",
        kind: "unavailable",
        reason: "not_found",
        message: expect.stringContaining("could not be observed"),
      },
    ])
    const live = observation.observations[0]
    expect(live?.kind).toBe("observed")
    if (live?.kind === "observed") {
      expect(live.runs[0]?.htmlUrl).toBe(
        "https://dev.azure.com/acme/widgets/_build/results?buildId=42",
      )
    }
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
      service
        .observeCiGate(repository, {
          definitionIdentities: ["12"],
          lastRunIdentities: {},
        })
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
    expect(error.statusCode).toBe(403)
    expect(error.message).toContain("Build read required")
    expect(error.message).not.toContain("TF401444")
    expect(formatUserFacingError(error)).not.toContain("TF401444")
  })
})
