import { Effect, Layer, ManagedRuntime, Random } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import {
  LINEAR_API_KEY_CREATION_URL,
  LINEAR_API_KEY_ENV_VAR,
  LINEAR_API_KEY_SECRET_NAME,
  LINEAR_VAULT_ACCOUNT,
  LINEAR_VAULT_PROVIDER,
} from "@ready-for-agent/linear-service"
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
  hasLinearAmbientCredential,
  linearCredential,
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

const linearTrackedRepo: Repository = {
  id: "repo-01J00000000000000000000013",
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
  issueTracker: "linear",
}

describe("repositoryCredential", () => {
  test("suggests a GitHub token secret name and creation URL", () => {
    const credential = repositoryCredential(githubRepo, null)
    expect(credential.githubTokenSecretName).toBe(
      githubTokenSecretName(githubRepo),
    )
    expect(credential.githubTokenCreationUrl).toContain("github.com")
    const creationUrl = new URL(credential.githubTokenCreationUrl)
    expect(creationUrl.searchParams.get("description")).toContain(
      "docs/forge-token-scopes.md",
    )
  })

  test("suggests a GitLab token secret name and instance-scoped creation URL", () => {
    const credential = repositoryCredential(gitlabRepo, null)
    expect(credential.githubTokenSecretName).toBe(
      gitlabTokenSecretName(gitlabRepo),
    )
    const creationUrl = new URL(credential.githubTokenCreationUrl)
    expect(`${creationUrl.origin}${creationUrl.pathname}`).toBe(
      "https://git.example.com/-/user_settings/personal_access_tokens",
    )
    expect(creationUrl.searchParams.get("scopes")).toBe("api,write_repository")
    expect(creationUrl.searchParams.get("description")).toContain(
      "docs/forge-token-scopes.md",
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

describe("linearCredential", () => {
  test("suggests the personal Linear API key independently of GitHub", () => {
    const missing = linearCredential(null)
    expect(missing.configured).toBe(false)
    expect(missing.secretName).toBe(LINEAR_API_KEY_SECRET_NAME)
    expect(missing.creationUrl).toBe(LINEAR_API_KEY_CREATION_URL)

    const stored = linearCredential("LINEAR_API_KEY_RENAMED")
    expect(stored.configured).toBe(true)
    expect(stored.secretName).toBe("LINEAR_API_KEY_RENAMED")
  })
})

describe("activatePollingIfCredentialed (Linear)", () => {
  const withLinearEnv = async (
    value: string | undefined,
    run: () => Promise<void>,
  ) => {
    const previous = process.env[LINEAR_API_KEY_ENV_VAR]
    if (value === undefined) delete process.env[LINEAR_API_KEY_ENV_VAR]
    else process.env[LINEAR_API_KEY_ENV_VAR] = value
    try {
      await run()
    } finally {
      if (previous === undefined) delete process.env[LINEAR_API_KEY_ENV_VAR]
      else process.env[LINEAR_API_KEY_ENV_VAR] = previous
    }
  }

  test("activates polling from ambient LINEAR_API_KEY when Keymaxxer is disabled", async () => {
    await withLinearEnv("lin_api_test", async () => {
      expect(hasLinearAmbientCredential()).toBe(true)
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
          activatePollingIfCredentialed(linearTrackedRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([linearTrackedRepo.id])
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("does not activate Linear polling without a Linear credential", async () => {
    await withLinearEnv(undefined, async () => {
      expect(hasLinearAmbientCredential()).toBe(false)
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
          activatePollingIfCredentialed(linearTrackedRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([])
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("activates Linear polling from the Linear vault, not GitHub", async () => {
    await withLinearEnv(undefined, async () => {
      const findSecretCalls: { provider: string; account: string }[] = []
      const activated: string[] = []
      const runtime = makeRuntime(
        {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(true),
          findSecret: (input) => {
            findSecretCalls.push(input)
            return Effect.succeed(
              input.provider === LINEAR_VAULT_PROVIDER &&
                input.account === LINEAR_VAULT_ACCOUNT
                ? LINEAR_API_KEY_SECRET_NAME
                : null,
            )
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
          activatePollingIfCredentialed(linearTrackedRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(findSecretCalls).toEqual([
          { provider: LINEAR_VAULT_PROVIDER, account: LINEAR_VAULT_ACCOUNT },
        ])
        expect(activated).toEqual([linearTrackedRepo.id])
      } finally {
        await runtime.dispose()
      }
    })
  })

  test("does not start GitHub polling when Linear has no credential", async () => {
    await withLinearEnv(undefined, async () => {
      const activated: string[] = []
      const runtime = makeRuntime(
        {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(true),
          findSecret: (input) =>
            Effect.succeed(
              input.provider === "github" ? "GITHUB_TOKEN_ACME_WIDGETS" : null,
            ),
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
          activatePollingIfCredentialed(linearTrackedRepo).pipe(
            Random.withSeed(1),
          ),
        )
        expect(activated).toEqual([])
      } finally {
        await runtime.dispose()
      }
    })
  })
})
