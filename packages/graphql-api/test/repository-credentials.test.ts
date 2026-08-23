import { Effect, Layer, ManagedRuntime, Random } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import {
  QueueService,
  type QueueServiceShape,
} from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import { ISSUE_REFRESH_QUEUE } from "../src/lib/issue-polling.js"
import {
  type Repository,
  activatePollingIfCredentialed,
  azureDevOpsTokenSecretName,
  githubTokenSecretName,
  gitlabTokenSecretName,
  hasAzureDevOpsAmbientCredential,
  repositoryCredential,
} from "../src/lib/repository-credentials.js"
import { describe, expect, test } from "bun:test"

const githubRepo: Repository = {
  id: "repo-01J00000000000000000000010",
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

const gitlabRepo: Repository = {
  id: "repo-01J00000000000000000000011",
  forge: "gitlab",
  forgeHost: "git.example.com",
  projectPath: "group/widgets",
}

const azureDevOpsRepo: Repository = {
  id: "repo-01J00000000000000000000012",
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

describe("repositoryCredential", () => {
  test("suggests a GitHub token secret name and creation URL", () => {
    const credential = repositoryCredential(githubRepo, null)
    expect(credential.githubTokenSecretName).toBe(
      githubTokenSecretName(githubRepo),
    )
    expect(credential.githubTokenCreationUrl).toContain("github.com")
  })

  test("suggests a GitLab token secret name and instance-scoped creation URL", () => {
    const credential = repositoryCredential(gitlabRepo, null)
    expect(credential.githubTokenSecretName).toBe(
      gitlabTokenSecretName(gitlabRepo),
    )
    expect(credential.githubTokenCreationUrl).toBe(
      "https://git.example.com/-/user_settings/personal_access_tokens",
    )
  })

  test("suggests an Azure DevOps token secret name and org-scoped creation URL", () => {
    const credential = repositoryCredential(azureDevOpsRepo, null)
    expect(credential.githubTokenSecretName).toBe(
      azureDevOpsTokenSecretName(azureDevOpsRepo),
    )
    expect(credential.githubTokenSecretName).toBe(
      "AZURE_DEVOPS_TOKEN_ACME_WIDGETS",
    )
    expect(credential.githubTokenCreationUrl).toBe(
      "https://dev.azure.com/acme/_usersSettings/tokens",
    )
  })

  test("prefers an existing configured token over the suggested name", () => {
    const credential = repositoryCredential(
      azureDevOpsRepo,
      "AZURE_DEVOPS_TOKEN_RENAMED",
    )
    expect(credential.configured).toBe(true)
    expect(credential.githubTokenSecretName).toBe("AZURE_DEVOPS_TOKEN_RENAMED")
  })
})

const makeRuntime = (
  keymaxxer: KeymaxxerServiceShape,
  queue: QueueServiceShape,
) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(KeymaxxerService, keymaxxer),
      Layer.succeed(QueueService, queue),
    ),
  )

const ambientOnlyKeymaxxer: KeymaxxerServiceShape = {
  enabled: false,
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(false),
  findSecret: () => Effect.die("must not inspect the vault when disabled"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(false),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
}

describe("activatePollingIfCredentialed (GitHub)", () => {
  test("activates polling when Keymaxxer is disabled", async () => {
    const activated: string[] = []
    const runtime = makeRuntime(
      ambientOnlyKeymaxxer,
      stubQueueService({
        enqueue: (queueName, payload) =>
          Effect.sync(() => {
            if (queueName === ISSUE_REFRESH_QUEUE) {
              activated.push((payload as { repositoryId: string }).repositoryId)
            }
            return "job-1" as never
          }),
        ensureKeyed: () =>
          Effect.succeed({ jobId: "job-1" as never, created: true }),
      }),
    )
    try {
      await runtime.runPromise(
        activatePollingIfCredentialed(githubRepo).pipe(Random.withSeed(1)),
      )
      expect(activated).toEqual([githubRepo.id])
    } finally {
      await runtime.dispose()
    }
  })

  test("activates polling from a vault secret when Keymaxxer is effective", async () => {
    const findSecretCalls: { provider: string; account: string }[] = []
    const activated: string[] = []
    const runtime = makeRuntime(
      {
        initialize: Effect.void,
        hasSecret: () => Effect.succeed(true),
        findSecret: (input) => {
          findSecretCalls.push(input)
          return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
        },
        findSecrets: () => Effect.succeed([]),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      } satisfies KeymaxxerServiceShape,
      stubQueueService({
        enqueue: (_queueName, payload) =>
          Effect.sync(() => {
            activated.push((payload as { repositoryId: string }).repositoryId)
            return "job-1" as never
          }),
        ensureKeyed: () =>
          Effect.succeed({ jobId: "job-1" as never, created: true }),
      }),
    )
    try {
      await runtime.runPromise(
        activatePollingIfCredentialed(githubRepo).pipe(Random.withSeed(1)),
      )
      expect(findSecretCalls).toEqual([
        { provider: "github", account: "acme/widgets" },
      ])
      expect(activated).toEqual([githubRepo.id])
    } finally {
      await runtime.dispose()
    }
  })

  test("does not activate polling on a clean vault miss", async () => {
    const activated: string[] = []
    const runtime = makeRuntime(
      {
        initialize: Effect.void,
        hasSecret: () => Effect.succeed(false),
        findSecret: () => Effect.succeed(null),
        findSecrets: () => Effect.succeed([]),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      } satisfies KeymaxxerServiceShape,
      stubQueueService({
        enqueue: (_queueName, payload) =>
          Effect.sync(() => {
            activated.push((payload as { repositoryId: string }).repositoryId)
            return "job-1" as never
          }),
        ensureKeyed: () =>
          Effect.succeed({ jobId: "job-1" as never, created: true }),
      }),
    )
    try {
      await runtime.runPromise(
        activatePollingIfCredentialed(githubRepo).pipe(Random.withSeed(1)),
      )
      expect(activated).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("activates polling from ambient credentials when the vault errors", async () => {
    const activated: string[] = []
    const runtime = makeRuntime(
      {
        initialize: Effect.void,
        hasSecret: () => Effect.succeed(true),
        findSecret: () =>
          Effect.fail(keymaxxerError("findSecret", "Keymaxxer list failed")),
        findSecrets: () => Effect.succeed([]),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      } satisfies KeymaxxerServiceShape,
      stubQueueService({
        enqueue: (_queueName, payload) =>
          Effect.sync(() => {
            activated.push((payload as { repositoryId: string }).repositoryId)
            return "job-1" as never
          }),
        ensureKeyed: () =>
          Effect.succeed({ jobId: "job-1" as never, created: true }),
      }),
    )
    try {
      await runtime.runPromise(
        activatePollingIfCredentialed(githubRepo).pipe(Random.withSeed(1)),
      )
      expect(activated).toEqual([githubRepo.id])
    } finally {
      await runtime.dispose()
    }
  })
})

describe("activatePollingIfCredentialed (Azure DevOps)", () => {
  test("activates polling from the ambient AZURE_DEVOPS_EXT_PAT when Keymaxxer is disabled", async () => {
    const previous = process.env.AZURE_DEVOPS_EXT_PAT
    process.env.AZURE_DEVOPS_EXT_PAT = "pat-value"
    try {
      expect(hasAzureDevOpsAmbientCredential()).toBe(true)
      const activated: string[] = []
      const runtime = makeRuntime(
        ambientOnlyKeymaxxer,
        stubQueueService({
          enqueue: (queueName, payload) =>
            Effect.sync(() => {
              if (queueName === ISSUE_REFRESH_QUEUE) {
                activated.push(
                  (payload as { repositoryId: string }).repositoryId,
                )
              }
              return "job-1" as never
            }),
          ensureKeyed: () =>
            Effect.succeed({ jobId: "job-1" as never, created: true }),
        }),
      )
      try {
        await runtime.runPromise(
          activatePollingIfCredentialed(azureDevOpsRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([azureDevOpsRepo.id])
      } finally {
        await runtime.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
      else process.env.AZURE_DEVOPS_EXT_PAT = previous
    }
  })

  test("does not activate polling without the ambient PAT when Keymaxxer is disabled", async () => {
    const previous = process.env.AZURE_DEVOPS_EXT_PAT
    delete process.env.AZURE_DEVOPS_EXT_PAT
    try {
      expect(hasAzureDevOpsAmbientCredential()).toBe(false)
      const activated: string[] = []
      const runtime = makeRuntime(
        ambientOnlyKeymaxxer,
        stubQueueService({
          enqueue: (_queueName, payload) =>
            Effect.sync(() => {
              activated.push((payload as { repositoryId: string }).repositoryId)
              return "job-1" as never
            }),
          ensureKeyed: () =>
            Effect.succeed({ jobId: "job-1" as never, created: true }),
        }),
      )
      try {
        await runtime.runPromise(
          activatePollingIfCredentialed(azureDevOpsRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([])
      } finally {
        await runtime.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
      else process.env.AZURE_DEVOPS_EXT_PAT = previous
    }
  })

  test("activates polling from a vault secret when Keymaxxer is effective", async () => {
    const findSecretCalls: { provider: string; account: string }[] = []
    const activated: string[] = []
    const runtime = makeRuntime(
      {
        initialize: Effect.void,
        hasSecret: () => Effect.succeed(true),
        findSecret: (input) => {
          findSecretCalls.push(input)
          return Effect.succeed("AZURE_DEVOPS_TOKEN_ACME_WIDGETS")
        },
        findSecrets: () => Effect.succeed([]),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      } satisfies KeymaxxerServiceShape,
      stubQueueService({
        enqueue: (_queueName, payload) =>
          Effect.sync(() => {
            activated.push((payload as { repositoryId: string }).repositoryId)
            return "job-1" as never
          }),
        ensureKeyed: () =>
          Effect.succeed({ jobId: "job-1" as never, created: true }),
      }),
    )
    try {
      await runtime.runPromise(
        activatePollingIfCredentialed(azureDevOpsRepo).pipe(Random.withSeed(1)),
      )
      expect(findSecretCalls).toEqual([
        { provider: "azure-devops", account: "acme/widgets" },
      ])
      expect(activated).toEqual([azureDevOpsRepo.id])
    } finally {
      await runtime.dispose()
    }
  })

  test("falls back to the ambient PAT when the vault has no secret", async () => {
    const previous = process.env.AZURE_DEVOPS_EXT_PAT
    process.env.AZURE_DEVOPS_EXT_PAT = "pat-value"
    try {
      const activated: string[] = []
      const runtime = makeRuntime(
        {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(false),
          findSecret: () => Effect.succeed(null),
          findSecrets: () => Effect.succeed([]),
          addSecret: () => Effect.succeed(true),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        } satisfies KeymaxxerServiceShape,
        stubQueueService({
          enqueue: (_queueName, payload) =>
            Effect.sync(() => {
              activated.push((payload as { repositoryId: string }).repositoryId)
              return "job-1" as never
            }),
          ensureKeyed: () =>
            Effect.succeed({ jobId: "job-1" as never, created: true }),
        }),
      )
      try {
        await runtime.runPromise(
          activatePollingIfCredentialed(azureDevOpsRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([azureDevOpsRepo.id])
      } finally {
        await runtime.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
      else process.env.AZURE_DEVOPS_EXT_PAT = previous
    }
  })

  test("falls back to the ambient PAT when the vault errors", async () => {
    const previous = process.env.AZURE_DEVOPS_EXT_PAT
    process.env.AZURE_DEVOPS_EXT_PAT = "pat-value"
    try {
      const activated: string[] = []
      const runtime = makeRuntime(
        {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(true),
          findSecret: () =>
            Effect.fail(keymaxxerError("findSecret", "sidecar down")),
          findSecrets: () => Effect.succeed([]),
          addSecret: () => Effect.succeed(true),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        } satisfies KeymaxxerServiceShape,
        stubQueueService({
          enqueue: (_queueName, payload) =>
            Effect.sync(() => {
              activated.push((payload as { repositoryId: string }).repositoryId)
              return "job-1" as never
            }),
          ensureKeyed: () =>
            Effect.succeed({ jobId: "job-1" as never, created: true }),
        }),
      )
      try {
        await runtime.runPromise(
          activatePollingIfCredentialed(azureDevOpsRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([azureDevOpsRepo.id])
      } finally {
        await runtime.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
      else process.env.AZURE_DEVOPS_EXT_PAT = previous
    }
  })
})
