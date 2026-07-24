import { Effect, Layer } from "effect"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import {
  agentTurnGitHubCredentialGuidance,
  isAgentTurnKeymaxxerEffective,
  resolveAgentTurnGitHubAuth,
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

describe("resolveAgentTurnGitHubAuth", () => {
  it("returns keymaxxer auth for a capable backend when the vault is enabled", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnGitHubAuth({
        githubOwner: "acme",
        githubRepo: "widgets",
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
      resolveAgentTurnGitHubAuth({
        githubOwner: "acme",
        githubRepo: "widgets",
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

  it("returns ambient auth when Keymaxxer is disabled on a capable backend", async () => {
    const auth = await Effect.runPromise(
      resolveAgentTurnGitHubAuth({
        githubOwner: "acme",
        githubRepo: "widgets",
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
