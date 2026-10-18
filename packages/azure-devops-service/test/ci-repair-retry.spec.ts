import { Effect } from "effect"
import { retryBuildProgram } from "../src/bin/retry-build.js"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
  makeAzureDevOpsServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const repository = {
  forge: "azure-devops" as const,
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

describe("Azure DevOps build retry", () => {
  test("PATCHes Update Build with retry=true", async () => {
    let seen: {
      readonly method: string
      readonly url: string
      readonly authorization: string | null
      readonly body: string | undefined
    } | null = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen = {
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input),
        authorization: headers.Authorization ?? null,
        body: typeof init?.body === "string" ? init.body : undefined,
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    await Effect.runPromise(service.retryBuild(repository, 42))
    expect(seen).toEqual({
      method: "PATCH",
      url: "https://dev.azure.com/acme/widgets/_apis/build/builds/42?retry=true&api-version=7.1",
      authorization: `Basic ${Buffer.from(":test-pat").toString("base64")}`,
      body: JSON.stringify({ id: 42 }),
    })
  })

  test("rejects a non-positive build id before calling Azure DevOps", async () => {
    let called = false
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async () => {
      called = true
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    await expect(
      Effect.runPromise(service.retryBuild(repository, 0)),
    ).rejects.toThrow(/Invalid build id 0/)
    expect(called).toBe(false)
  })

  test("rejects a project path that is not organization/project", async () => {
    let called = false
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async () => {
      called = true
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    await expect(
      Effect.runPromise(
        service.retryBuild({ ...repository, projectPath: "widgets" }, 42),
      ),
    ).rejects.toThrow(/Invalid Azure DevOps Project Path/)
    expect(called).toBe(false)
  })

  test("helper program retries the decoded build id", async () => {
    const calls: number[] = []
    await Effect.runPromise(
      retryBuildProgram([
        encode("azure-devops"),
        encode("dev.azure.com"),
        encode("acme/widgets"),
        encode("42"),
      ]).pipe(
        Effect.provideService(AzureDevOpsService, {
          retryBuild: (_repository, buildId) => {
            calls.push(buildId)
            return Effect.void
          },
        } as unknown as AzureDevOpsServiceShape),
      ),
    )
    expect(calls).toEqual([42])
  })

  test("helper program rejects a non-positive build id", async () => {
    await expect(
      Effect.runPromise(
        retryBuildProgram([
          encode("azure-devops"),
          encode("dev.azure.com"),
          encode("acme/widgets"),
          encode("0"),
        ]).pipe(
          Effect.provideService(AzureDevOpsService, {
            retryBuild: () => Effect.die("must not retry"),
          } as unknown as AzureDevOpsServiceShape),
        ),
      ),
    ).rejects.toThrow(/Invalid build id/)
  })
})
