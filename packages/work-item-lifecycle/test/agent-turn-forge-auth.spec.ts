import { Duration, Effect, Layer } from "effect"
import { AZURE_DEVOPS_VAULT_METADATA_BUDGET_SECONDS } from "@ready-for-agent/azure-devops-service"
import { GITLAB_VAULT_METADATA_BUDGET_SECONDS } from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import {
  AGENT_TURN_AZURE_DEVOPS_VAULT_METADATA_BUDGET,
  AGENT_TURN_GITLAB_VAULT_METADATA_BUDGET,
  CurrentCapturedAgentBackendId,
  CurrentStepRun,
  InvalidCapturedAgentBackendError,
  agentTurnAzureDevOpsVaultAccount,
  agentTurnForgeCredentialGuidance,
  agentTurnGitHubCredentialGuidance,
  agentTurnGitLabVaultAccount,
  isAgentTurnKeymaxxerEffective,
  resolveAgentTurnForgeAuth,
  stubActiveAgentBackendLayer,
  stubGrokActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const vaultEnabled = Layer.succeed(KeymaxxerService, {
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(true),
  findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies KeymaxxerServiceShape)

describe("isAgentTurnKeymaxxerEffective", () => {
  it("requires both capability and enablement", () => {
    expect(isAgentTurnKeymaxxerEffective(true, true)).toBe(true)
    expect(isAgentTurnKeymaxxerEffective(true, undefined)).toBe(true)
    expect(isAgentTurnKeymaxxerEffective(true, false)).toBe(false)
    expect(isAgentTurnKeymaxxerEffective(false, true)).toBe(false)
    expect(isAgentTurnKeymaxxerEffective(false, false)).toBe(false)
  })
})

describe("resolveAgentTurnForgeAuth", () => {
  it("returns keymaxxer auth for a capable backend when the vault is enabled", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(vaultEnabled, stubActiveAgentBackendLayer()),
        ),
      ),
    )
    expect(auth).toEqual({
      _tag: "keymaxxer",
      tokenName: "GITHUB_TOKEN_ACME_WIDGETS",
    })
  })

  it("returns ambient auth when the backend lacks KeymaxxerMcp", async () => {
    let findSecretCalled = false
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(true),
              findSecret: () => {
                findSecretCalled = true
                return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
              },
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubGrokActiveAgentBackendLayer,
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
    expect(findSecretCalled).toBe(false)
  })

  it("fails closed when ambient capture is set but not selectable", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolveAgentTurnForgeAuth({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        }).pipe(
          Effect.provideService(CurrentCapturedAgentBackendId, "not-a-backend"),
          Effect.provide(
            Layer.mergeAll(vaultEnabled, stubActiveAgentBackendLayer()),
          ),
        ),
      ),
    )
    expect(error).toBeInstanceOf(InvalidCapturedAgentBackendError)
    if (error instanceof InvalidCapturedAgentBackendError) {
      expect(error.backendId).toBe("not-a-backend")
    }
  })

  it("fails closed when capture is missing during an in-flight Step Run", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolveAgentTurnForgeAuth({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        }).pipe(
          Effect.provideService(CurrentCapturedAgentBackendId, null),
          Effect.provideService(CurrentStepRun, {
            stepRunId: "srun-test",
            repositoryId: "repo-test",
          }),
          Effect.provide(
            Layer.mergeAll(vaultEnabled, stubActiveAgentBackendLayer()),
          ),
        ),
      ),
    )
    expect(error).toBeInstanceOf(InvalidCapturedAgentBackendError)
    if (error instanceof InvalidCapturedAgentBackendError) {
      expect(error.message).toContain("missing on an in-flight Step Run")
    }
  })

  it("returns ambient auth when Keymaxxer is disabled on a capable backend", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              enabled: false,
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(false),
              findSecret: () => Effect.die("must not inspect the vault"),
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(false),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
  })

  it("uses the Repository-scoped GitLab credential when Keymaxxer is effective", async () => {
    const findSecretCalls: {
      readonly provider: string
      readonly account: string
    }[] = []
    const repository = {
      forge: "gitlab" as const,
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    }
    expect(agentTurnGitLabVaultAccount(repository)).toBe(
      "git.drupalcode.org/project/oauth_client",
    )
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth(repository).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(true),
              findSecret: (input) => {
                findSecretCalls.push(input)
                return Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT")
              },
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({
      _tag: "keymaxxer",
      tokenName: "GITLAB_TOKEN_PROJECT_OAUTH_CLIENT",
    })
    expect(findSecretCalls).toEqual([
      {
        provider: "gitlab",
        account: agentTurnGitLabVaultAccount(repository),
      },
    ])
  })

  it("falls back to ambient GitLab auth when no vault secret exists", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "gitlab",
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(false),
              findSecret: () => Effect.succeed(null),
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
  })

  it("falls back to ambient GitLab auth when vault findSecret errors", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "gitlab",
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(true),
              findSecret: () =>
                Effect.fail(keymaxxerError("findSecret", "sidecar down")),
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
  })

  it("falls back to ambient GitLab auth when vault findSecret hangs past budget", async () => {
    expect(Duration.toMillis(AGENT_TURN_GITLAB_VAULT_METADATA_BUDGET)).toBe(
      GITLAB_VAULT_METADATA_BUDGET_SECONDS * 1000,
    )
    const started = Date.now()
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth(
        {
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
        },
        { gitlabVaultMetadataBudget: Duration.millis(40) },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(true),
              findSecret: () => Effect.never,
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("uses the Repository-scoped Azure DevOps credential when Keymaxxer is effective", async () => {
    const findSecretCalls: {
      readonly provider: string
      readonly account: string
    }[] = []
    const repository = {
      forge: "azure-devops" as const,
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    }
    expect(agentTurnAzureDevOpsVaultAccount(repository)).toBe("acme/widgets")
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth(repository).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
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
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({
      _tag: "keymaxxer",
      tokenName: "AZURE_DEVOPS_TOKEN_ACME_WIDGETS",
    })
    expect(findSecretCalls).toEqual([
      { provider: "azure-devops", account: "acme/widgets" },
    ])
  })

  it("falls back to ambient Azure DevOps auth when no vault secret exists", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth({
        forge: "azure-devops",
        forgeHost: "dev.azure.com",
        projectPath: "acme/widgets",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(false),
              findSecret: () => Effect.succeed(null),
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
  })

  it("falls back to ambient Azure DevOps auth when vault findSecret hangs past budget", async () => {
    expect(
      Duration.toMillis(AGENT_TURN_AZURE_DEVOPS_VAULT_METADATA_BUDGET),
    ).toBe(AZURE_DEVOPS_VAULT_METADATA_BUDGET_SECONDS * 1000)
    const started = Date.now()
    const auth = await Effect.runPromise(
      resolveAgentTurnForgeAuth(
        {
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "acme/widgets",
        },
        { azureDevOpsVaultMetadataBudget: Duration.millis(40) },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(KeymaxxerService, {
              initialize: Effect.void,
              hasSecret: () => Effect.succeed(true),
              findSecret: () => Effect.never,
              findSecrets: () => Effect.succeed([]),
              addSecret: () => Effect.succeed(true),
              runWithSecrets: () =>
                Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            } satisfies KeymaxxerServiceShape),
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )
    expect(auth).toEqual({ _tag: "ambient" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("agentTurnGitHubCredentialGuidance", () => {
  it("mentions Keymaxxer only for vault-backed auth", () => {
    expect(
      agentTurnGitHubCredentialGuidance(
        { _tag: "keymaxxer", tokenName: "GITHUB_TOKEN_ACME_WIDGETS" },
        "GitHub CLI or API access",
      ),
    ).toContain("keymaxxer_run")
    const ambient = agentTurnGitHubCredentialGuidance(
      { _tag: "ambient" },
      "GitHub CLI or API access",
    )
    expect(ambient.toLowerCase()).not.toContain("keymaxxer")
    expect(ambient).toContain("ambient authentication")
  })
})

describe("agentTurnForgeCredentialGuidance", () => {
  it("preserves GitHub guidance", () => {
    expect(
      agentTurnForgeCredentialGuidance(
        {
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        },
        { _tag: "ambient" },
        "GitHub CLI or API access",
      ),
    ).toBe(
      "Use the gh CLI with the existing ambient authentication for any GitHub CLI or API access.",
    )
  })

  it("guides ambient GitLab turns to host-authenticated glab and never curl or gh", () => {
    const guidance = agentTurnForgeCredentialGuidance(
      {
        forge: "gitlab",
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      },
      { _tag: "ambient" },
      "GitLab Issue or API access",
    )
    expect(guidance).toContain("glab")
    expect(guidance).toContain("git.drupalcode.org")
    expect(guidance).toContain(
      "https://git.drupalcode.org/project/oauth_client",
    )
    expect(guidance).not.toContain("curl")
    expect(guidance).not.toMatch(/\bgh\b/i)
  })

  it("guides vault-backed GitLab turns to run glab through Keymaxxer", () => {
    const guidance = agentTurnForgeCredentialGuidance(
      {
        forge: "gitlab",
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      },
      {
        _tag: "keymaxxer",
        tokenName: "GITLAB_TOKEN_PROJECT_OAUTH_CLIENT",
      },
      "GitLab Issue or API access",
    )
    expect(guidance).toContain("keymaxxer_run")
    expect(guidance).toContain("glab")
    expect(guidance).toContain(
      'GITLAB_TOKEN="$GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"',
    )
    expect(guidance).toContain('GITLAB_HOST="https://git.drupalcode.org"')
    expect(guidance).toContain(
      'set "GITLAB_TOKEN=%GITLAB_TOKEN_PROJECT_OAUTH_CLIENT%"',
    )
    expect(guidance).toContain('set "GITLAB_HOST=https://git.drupalcode.org"')
    expect(guidance).toContain(
      "https://git.drupalcode.org/project/oauth_client",
    )
    expect(guidance).not.toContain("curl")
    expect(guidance).not.toMatch(/\bgh\b/i)
  })

  it("guides ambient Azure DevOps turns to the REST API with AZURE_DEVOPS_EXT_PAT", () => {
    const guidance = agentTurnForgeCredentialGuidance(
      {
        forge: "azure-devops",
        forgeHost: "dev.azure.com",
        projectPath: "acme/widgets",
      },
      { _tag: "ambient" },
      "Azure DevOps work item or API access",
    )
    expect(guidance).toContain("AZURE_DEVOPS_EXT_PAT")
    expect(guidance).toContain("https://dev.azure.com/acme/widgets")
    expect(guidance).not.toContain("keymaxxer_run")
    expect(guidance).not.toMatch(/\bgh\b/i)
    expect(guidance).not.toMatch(/\bglab\b/i)
  })

  it("guides vault-backed Azure DevOps turns to run keymaxxer_run against the REST API", () => {
    const guidance = agentTurnForgeCredentialGuidance(
      {
        forge: "azure-devops",
        forgeHost: "dev.azure.com",
        projectPath: "acme/widgets",
      },
      {
        _tag: "keymaxxer",
        tokenName: "AZURE_DEVOPS_TOKEN_ACME_WIDGETS",
      },
      "Azure DevOps work item or API access",
    )
    expect(guidance).toContain("keymaxxer_run")
    expect(guidance).toContain("AZURE_DEVOPS_TOKEN_ACME_WIDGETS")
    expect(guidance).toContain("https://dev.azure.com/acme/widgets")
    expect(guidance).not.toMatch(/\bgh\b/i)
    expect(guidance).not.toMatch(/\bglab\b/i)
  })
})
