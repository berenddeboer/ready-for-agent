import { Effect, Layer, Result } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
  testRepositoryId,
} from "@ready-for-agent/db-service/test"
import type { ForgeRepository } from "@ready-for-agent/forge-contract"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import {
  CiRepairRerunError,
  ciRepairRunIdFromIdentity,
  dedupeCiRepairRunIdentities,
  rerunCiRepairJobs,
} from "../src/lib/ci-repair-rerun.js"
import { describe, expect, it } from "bun:test"

const repositoryId = testRepositoryId

const runFailure = async (
  identities: readonly string[],
  layers: {
    readonly repositories?: ReturnType<typeof makeRepositoryRecord>[]
    readonly listFails?: boolean
    readonly github?: object
    readonly gitlab?: object
    readonly azure?: object
    readonly contextRepositoryId?: string
  } = {},
): Promise<string> => {
  const db = layers.listFails
    ? stubDbServiceLayer({
        listRepositories: Effect.fail(new Error("db down")) as never,
      })
    : stubDbServiceLayer({
        listRepositories: Effect.succeed(layers.repositories ?? []),
      })
  const result = await Effect.runPromise(
    rerunCiRepairJobs(
      { repositoryId: layers.contextRepositoryId ?? repositoryId },
      identities,
    ).pipe(
      Effect.result,
      Effect.provide(db),
      Effect.provide(
        Layer.succeed(GitHubService, (layers.github ?? {}) as never),
      ),
      Effect.provide(
        Layer.succeed(GitLabService, (layers.gitlab ?? {}) as never),
      ),
      Effect.provide(
        Layer.succeed(AzureDevOpsService, (layers.azure ?? {}) as never),
      ),
    ),
  )
  if (Result.isSuccess(result)) {
    throw new Error("expected CiRepairRerunError")
  }
  const error = result.failure
  if (!(error instanceof CiRepairRerunError)) {
    throw new Error(`expected CiRepairRerunError, got ${String(error)}`)
  }
  return error.message
}

const runSuccess = (
  identities: readonly string[],
  layers: {
    readonly repositories: ReturnType<typeof makeRepositoryRecord>[]
    readonly github?: object
    readonly gitlab?: object
    readonly azure?: object
  },
) =>
  Effect.runPromise(
    rerunCiRepairJobs({ repositoryId }, identities).pipe(
      Effect.provide(
        stubDbServiceLayer({
          listRepositories: Effect.succeed(layers.repositories),
        }),
      ),
      Effect.provide(
        Layer.succeed(GitHubService, (layers.github ?? {}) as never),
      ),
      Effect.provide(
        Layer.succeed(GitLabService, (layers.gitlab ?? {}) as never),
      ),
      Effect.provide(
        Layer.succeed(AzureDevOpsService, (layers.azure ?? {}) as never),
      ),
    ),
  )

describe("ciRepairRunIdFromIdentity", () => {
  it("reads the positive integer prefix before the first colon", () => {
    expect(ciRepairRunIdFromIdentity("123")).toBe(123)
    expect(ciRepairRunIdFromIdentity("123:2")).toBe(123)
    expect(ciRepairRunIdFromIdentity(" 123:attempt ")).toBe(123)
    expect(ciRepairRunIdFromIdentity("0")).toBeNull()
    expect(ciRepairRunIdFromIdentity("-1")).toBeNull()
    expect(ciRepairRunIdFromIdentity("1.5")).toBeNull()
    expect(ciRepairRunIdFromIdentity(":1")).toBeNull()
    expect(ciRepairRunIdFromIdentity("nope")).toBeNull()
    expect(ciRepairRunIdFromIdentity("9007199254740993")).toBeNull()
  })
})

describe("dedupeCiRepairRunIdentities", () => {
  it("drops blanks and identities that name the same numeric run", () => {
    expect(
      dedupeCiRepairRunIdentities([" 10:1 ", "10:2", "", "11:1", "11:1", "  "]),
    ).toEqual(["10:1", "11:1"])
  })

  it("keeps distinct invalid identities so validation can fail closed", () => {
    expect(dedupeCiRepairRunIdentities(["foo", "foo", "bar"])).toEqual([
      "foo",
      "bar",
    ])
  })
})

describe("rerunCiRepairJobs", () => {
  it("reruns each distinct GitHub run id and passes the forge repository", async () => {
    const calls: {
      readonly runId: number
      readonly repository: ForgeRepository
    }[] = []
    const record = makeRepositoryRecord()
    await runSuccess(["10:1", "10:2", " 11:1 ", "11:1"], {
      repositories: [record],
      github: {
        rerunWorkflowRun: (repository: ForgeRepository, runId: number) =>
          Effect.sync(() => {
            calls.push({ runId, repository })
          }),
      },
    })
    expect(calls).toEqual([
      {
        runId: 10,
        repository: {
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        },
      },
      {
        runId: 11,
        repository: {
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        },
      },
    ])
  })

  it("rejects an invalid identity before any forge call", async () => {
    const calls: number[] = []
    const message = await runFailure(["10:1", "nope"], {
      repositories: [makeRepositoryRecord()],
      github: {
        rerunWorkflowRun: (_repository: ForgeRepository, runId: number) =>
          Effect.sync(() => {
            calls.push(runId)
          }),
      },
    })
    expect(calls).toEqual([])
    expect(message).toBe(
      "Invalid CI run identity nope: expected a positive integer id before the first colon",
    )
  })

  it("requires at least one run identity", async () => {
    expect(await runFailure(["", "  "])).toBe(
      "CI Repair rerun requires at least one run identity",
    )
  })

  it("fails when the repository is missing or cannot be listed", async () => {
    expect(
      await runFailure(["10:1"], {
        repositories: [],
      }),
    ).toBe(`Repository ${repositoryId} was not found for a CI job rerun`)
    expect(
      await runFailure(["10:1"], {
        listFails: true,
      }),
    ).toBe("Failed to resolve the repository for a CI job rerun: db down")
  })

  it("stops at the first GitHub rerun failure", async () => {
    const calls: number[] = []
    const message = await runFailure(["10:1", "11:2", "12:1"], {
      repositories: [makeRepositoryRecord()],
      github: {
        rerunWorkflowRun: (_repository: ForgeRepository, runId: number) => {
          calls.push(runId)
          return runId === 11 ? Effect.fail(new Error("boom")) : Effect.void
        },
      },
    })
    expect(calls).toEqual([10, 11])
    expect(message).toBe("Failed to rerun CI run 11:2: boom")
  })

  it("fails closed when the GitLab service cannot rerun pipelines", async () => {
    const message = await runFailure(["99:1"], {
      repositories: [
        makeRepositoryRecord({
          forge: "gitlab",
          forgeHost: "gitlab.example",
        }),
      ],
      gitlab: {},
    })
    expect(message).toBe("This Forge cannot rerun CI jobs (gitlab)")
  })

  it("fails closed when the Azure DevOps service cannot rerun builds", async () => {
    const message = await runFailure(["42:1"], {
      repositories: [
        makeRepositoryRecord({
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "acme/widgets",
        }),
      ],
      azure: {},
    })
    expect(message).toBe("This Forge cannot rerun CI jobs (azure-devops)")
  })

  it("calls GitLab retryPipeline and Azure retryBuild through the optional cast", async () => {
    const gitlabCalls: string[] = []
    await runSuccess(["99:3"], {
      repositories: [
        makeRepositoryRecord({
          forge: "gitlab",
          forgeHost: "gitlab.example",
          projectPath: "acme/widgets",
        }),
      ],
      gitlab: {
        retryPipeline: (repository: ForgeRepository, pipelineId: number) =>
          Effect.sync(() => {
            gitlabCalls.push(`${repository.projectPath}:${pipelineId}`)
          }),
      },
    })
    expect(gitlabCalls).toEqual(["acme/widgets:99"])

    const azureCalls: string[] = []
    await runSuccess(["42:1", "42:2"], {
      repositories: [
        makeRepositoryRecord({
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "acme/widgets",
        }),
      ],
      azure: {
        retryBuild: (repository: ForgeRepository, buildId: number) =>
          Effect.sync(() => {
            azureCalls.push(`${repository.projectPath}:${buildId}`)
          }),
      },
    })
    expect(azureCalls).toEqual(["acme/widgets:42"])
  })
})
