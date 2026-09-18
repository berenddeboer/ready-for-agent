import { readFileSync } from "node:fs"
import { join } from "node:path"
import { QueryClient } from "@tanstack/react-query"
import {
  configQueryKey,
  configSelection,
  createConfigQuery,
} from "../src/config-query.ts"
import { createHarnessGraphqlClient } from "../src/harness-graphql.ts"
import { describe, expect, test } from "bun:test"

const requiredConfigFields = [
  "selectedAgentBackend",
  "defaultModel",
  "defaultThinkingLevel",
  "reviewModel",
  "reviewThinkingLevel",
  "maxConcurrentAgentTurns",
  "maxConcurrentWorkItems",
  "unfinishedWorkItemCount",
  "blockingUnfinishedWorkItemCount",
] as const

const completeConfig = {
  selectedAgentBackend: "opencode",
  defaultModel: "gpt-5",
  defaultThinkingLevel: "high",
  reviewModel: "gpt-5-review",
  reviewThinkingLevel: "low",
  maxConcurrentAgentTurns: 2,
  maxConcurrentWorkItems: 5,
  unfinishedWorkItemCount: 3,
  blockingUnfinishedWorkItemCount: 1,
}

const source = (relativePath: string) =>
  readFileSync(join(import.meta.dir, relativePath), "utf8")

const requestBody = (init?: RequestInit): string => {
  if (typeof init?.body === "string") {
    return init.body
  }
  return ""
}

const withMockedConfigFetch = async (
  run: () => Promise<void>,
): Promise<readonly string[]> => {
  const bodies: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(requestBody(init))
    return new Response(JSON.stringify({ data: { config: completeConfig } }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
  return bodies
}

describe("shared Harness Config query", () => {
  test("selects every field Home and Settings share on the config cache", () => {
    for (const field of requiredConfigFields) {
      expect(configSelection[field]).toBe(true)
    }
    expect(configQueryKey).toEqual(["config"])
  })

  test("Home and Settings consume one query factory instead of local copies", () => {
    const home = source("../src/home-page-content.tsx")
    const root = source("../src/routes/__root.tsx")
    const live = source("../src/refresh-work-items-live.ts")

    expect(home).toContain('from "./config-query.js"')
    expect(home).toContain("createConfigQuery(graphql)")
    expect(home).not.toMatch(/const configQuery = \{/)

    expect(root).toContain('from "../config-query.js"')
    expect(root).toContain("createConfigQuery(graphql)")
    expect(root).toContain("...configSelection")
    expect(root).not.toMatch(/const configQuery = \{/)

    expect(live).toContain('from "./config-query.js"')
    expect(live).toContain("configQueryKey")
    expect(live).not.toMatch(/const configQueryKey = \["config"\]/)
  })

  test("callers keep their own GraphQL batching and isolate CI Gate catalog", () => {
    const home = source("../src/home-page-content.tsx")
    const root = source("../src/routes/__root.tsx")

    expect(home).toContain("createHarnessGraphqlClient({ batch: true })")
    expect(home).toContain("createHarnessGraphqlClient({ batch: false })")
    expect(home).toMatch(
      /ciGateCatalogQuery[\s\S]*graphqlUnbatched\.query\(\{[\s\S]*ciGateCatalog:/,
    )
    expect(home).toContain("const configQuery = createConfigQuery(graphql)")
    expect(home).not.toContain("createConfigQuery(graphqlUnbatched)")

    expect(root).toContain("const graphql = createHarnessGraphqlClient()")
    expect(root).toContain("const configQuery = createConfigQuery(graphql)")
    expect(root).not.toContain("createHarnessGraphqlClient({ batch:")
  })

  test("batched and unbatched factories share cache key and request the full shape", async () => {
    const batched = createConfigQuery(
      createHarnessGraphqlClient({ batch: true }),
    )
    const unbatched = createConfigQuery(createHarnessGraphqlClient())
    expect(batched.queryKey).toEqual(["config"])
    expect(unbatched.queryKey).toEqual(batched.queryKey)

    const bodies = await withMockedConfigFetch(async () => {
      const queryClient = new QueryClient()
      const fromHome = await queryClient.fetchQuery(batched)
      expect(fromHome).toEqual(completeConfig)
      expect(
        queryClient.getQueryData<typeof completeConfig>(unbatched.queryKey),
      ).toEqual(completeConfig)
      const fromSettings = await unbatched.queryFn()
      expect(fromSettings).toEqual(completeConfig)
    })

    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      for (const field of requiredConfigFields) {
        expect(body).toContain(field)
      }
    }
  })
})
