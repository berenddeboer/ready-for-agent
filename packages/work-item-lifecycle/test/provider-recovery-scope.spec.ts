import {
  alignRecoveryAttempt,
  providerRecoveryFollowerOffsetMs,
  providerRecoveryScopeKey,
  providerRecoveryScopeKind,
  safeProviderAccountIdentity,
} from "../src/lib/provider-recovery-scope.js"
import { describe, expect, it } from "bun:test"

describe("Provider Recovery Cooldown scope", () => {
  it("keeps model overload off unrelated models and providers", () => {
    expect(providerRecoveryScopeKind("server_overloaded")).toBe("model")
    const codex = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.5",
      kind: "model",
    })
    const otherModel = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.4",
      kind: "model",
    })
    const otherProvider = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "bedrock",
      accountId: null,
      model: "gpt-5.5",
      kind: "model",
    })
    const otherBackend = providerRecoveryScopeKey({
      backend: "opencode",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.5",
      kind: "model",
    })
    expect(new Set([codex, otherModel, otherProvider, otherBackend]).size).toBe(
      4,
    )
  })

  it("uses a broader key for explicit provider-wide rate limits", () => {
    expect(providerRecoveryScopeKind("usage_limit_exceeded")).toBe("provider")
    expect(providerRecoveryScopeKind("rate_limit_exceeded")).toBe("provider")
    expect(providerRecoveryScopeKind("provider.quota")).toBe("provider")
    expect(providerRecoveryScopeKind("provider.rate-limit")).toBe("provider")
    const wide = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.5",
      kind: "provider",
    })
    const otherModel = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.4",
      kind: "provider",
    })
    expect(wide).toBe(otherModel)
    expect(wide).not.toBe(
      providerRecoveryScopeKey({
        backend: "codex",
        providerId: "bedrock",
        accountId: null,
        model: "gpt-5.5",
        kind: "provider",
      }),
    )
  })

  it("separates safe account identities and drops credentials", () => {
    expect(safeProviderAccountIdentity("acct_chatgpt_1")).toBe("acct_chatgpt_1")
    expect(safeProviderAccountIdentity("op@example.com")).toBe("op@example.com")
    expect(safeProviderAccountIdentity("sk-live-secret-token-value")).toBeNull()
    expect(safeProviderAccountIdentity("api_key_production")).toBeNull()
    expect(safeProviderAccountIdentity("Bearer secret")).toBeNull()
    expect(safeProviderAccountIdentity("[redacted]")).toBeNull()
    expect(safeProviderAccountIdentity("  ")).toBeNull()
    const first = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: "acct_chatgpt_1",
      model: "gpt-5.5",
      kind: "model",
    })
    const second = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: "acct_chatgpt_2",
      model: "gpt-5.5",
      kind: "model",
    })
    const dropped = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: "sk-live-secret-token-value",
      model: "gpt-5.5",
      kind: "model",
    })
    const omitted = providerRecoveryScopeKey({
      backend: "codex",
      providerId: "openai",
      accountId: null,
      model: "gpt-5.5",
      kind: "model",
    })
    expect(first).not.toBe(second)
    expect(dropped).toBe(omitted)
  })

  it("staggers followers away from one timestamp", () => {
    const offsets = [1, 2, 3].map((rank) =>
      providerRecoveryFollowerOffsetMs({
        rank,
        population: 3,
        delayMs: 60_000,
      }),
    )
    expect(new Set(offsets).size).toBe(3)
    expect(Math.min(...offsets)).toBeGreaterThan(0)
    expect(Math.max(...offsets)).toBeLessThanOrEqual(6_000)
  })

  it("keeps a follower at or after the shared deadline and exhausts past the item limit", () => {
    const waiting = alignRecoveryAttempt({
      now: 1_000,
      episodeStartedAt: 1_000,
      maxWaitMs: null,
      individualNextAttemptAt: 61_000,
      sharedDeadline: 121_000,
      role: "follower",
      followerOffsetMs: 2_000,
    })
    expect(waiting).toEqual({
      _tag: "wait",
      nextAttemptAt: 123_000,
      role: "follower",
    })
    const probe = alignRecoveryAttempt({
      now: 1_000,
      episodeStartedAt: 0,
      maxWaitMs: 90_000,
      individualNextAttemptAt: 61_000,
      sharedDeadline: 121_000,
      role: "probe",
      followerOffsetMs: 0,
    })
    expect(probe).toEqual({ _tag: "exhaust" })
  })
})
