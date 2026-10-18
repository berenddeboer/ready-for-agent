import { Effect } from "effect"
import { retryPipelineProgram } from "../src/bin/retry-pipeline.js"
import {
  GitLabService,
  type GitLabServiceShape,
  makeGitLabServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const repository = {
  forge: "gitlab" as const,
  forgeHost: "gitlab.example",
  projectPath: "acme/widgets",
}

describe("GitLab pipeline retry", () => {
  test("POSTs the project pipeline retry endpoint", async () => {
    let seen: {
      readonly method: string
      readonly url: string
      readonly token: string | null
      readonly body: string | undefined
    } | null = null
    const service = makeGitLabServiceFromToken("gl-token", (async (
      input,
      init,
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen = {
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input),
        token: headers["PRIVATE-TOKEN"] ?? null,
        body: typeof init?.body === "string" ? init.body : undefined,
      }
      return new Response(JSON.stringify({ id: 99 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    await Effect.runPromise(service.retryPipeline(repository, 99))
    expect(seen).toEqual({
      method: "POST",
      url: "https://gitlab.example/api/v4/projects/acme%2Fwidgets/pipelines/99/retry",
      token: "gl-token",
      body: undefined,
    })
  })

  test("rejects a non-positive pipeline id before calling GitLab", async () => {
    let called = false
    const service = makeGitLabServiceFromToken("gl-token", (async () => {
      called = true
      return new Response("{}", {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    await expect(
      Effect.runPromise(service.retryPipeline(repository, 0)),
    ).rejects.toThrow(/Invalid pipeline id 0/)
    expect(called).toBe(false)
  })

  test("helper program retries the decoded pipeline id", async () => {
    const calls: number[] = []
    await Effect.runPromise(
      retryPipelineProgram([
        encode("gitlab"),
        encode("gitlab.example"),
        encode("acme/widgets"),
        encode("99"),
      ]).pipe(
        Effect.provideService(GitLabService, {
          retryPipeline: (_repository, pipelineId) => {
            calls.push(pipelineId)
            return Effect.void
          },
        } as unknown as GitLabServiceShape),
      ),
    )
    expect(calls).toEqual([99])
  })

  test("helper program rejects a non-positive pipeline id", async () => {
    await expect(
      Effect.runPromise(
        retryPipelineProgram([
          encode("gitlab"),
          encode("gitlab.example"),
          encode("acme/widgets"),
          encode("0"),
        ]).pipe(
          Effect.provideService(GitLabService, {
            retryPipeline: () => Effect.die("must not retry"),
          } as unknown as GitLabServiceShape),
        ),
      ),
    ).rejects.toThrow(/Invalid pipeline id/)
  })
})
