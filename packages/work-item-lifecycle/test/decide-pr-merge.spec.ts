import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import {
  type LifecycleStepContext,
  decidePrMerge,
  decodeWorkItemMergePolicy,
  encodeWorkItemMergePolicyPin,
  makeWorkItemId,
  parseDecidePrMergeResult,
  resolveEffectiveMergePolicy,
  stubActiveAgentBackendLayer,
  stubGrokActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({
  localPath: "/repos/widgets",
  mergePolicy: "classify",
  includeAllIssueAuthors: false,
  waitForReadyForReviewChecks: true,
})

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  issueNumber: 42,
  issueTitle: null,
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  completionSummary: null,

  publicationTitle: null,

  publicationBody: null,
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})

const keymaxxer = Layer.succeed(KeymaxxerService, {
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(true),
  findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies KeymaxxerServiceShape)

describe("parseDecidePrMergeResult", () => {
  it("parses clanker merge and needs-human lines", () => {
    expect(
      parseDecidePrMergeResult("READY_FOR_AGENT_RESULT: CLANKER_MERGE"),
    ).toEqual({ _tag: "clanker_merge" })
    expect(
      parseDecidePrMergeResult(
        "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: Touches auth secrets",
      ),
    ).toEqual({
      _tag: "needs_human",
      reason: "Touches auth secrets",
    })
    expect(parseDecidePrMergeResult("no result line")).toBeNull()
  })

  it("accepts a needs-human reason wrapped in one pair of placeholder brackets", () => {
    expect(
      parseDecidePrMergeResult(
        "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <Touches auth secrets>",
      ),
    ).toEqual({
      _tag: "needs_human",
      reason: "Touches auth secrets",
    })
  })

  it("rejects conflicting or non-final result lines", () => {
    expect(
      parseDecidePrMergeResult(
        [
          "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: Touches auth secrets",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseDecidePrMergeResult(
        "READY_FOR_AGENT_RESULT: CLANKER_MERGE\nAdditional output",
      ),
    ).toBeNull()
  })
})

describe("decodeWorkItemMergePolicy", () => {
  it("decodes existing overrides and Merge Mode Always as classify / off / inherit / always", () => {
    expect(
      decodeWorkItemMergePolicy({
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: true,
      }),
    ).toBe("classify")
    expect(
      decodeWorkItemMergePolicy({
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: false,
      }),
    ).toBe("off")
    expect(
      decodeWorkItemMergePolicy({
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: null,
      }),
    ).toBeNull()
    expect(
      decodeWorkItemMergePolicy({
        workItemMergeMode: "always",
        workItemAutoMergeOverride: null,
      }),
    ).toBe("always")
    expect(
      decodeWorkItemMergePolicy({
        workItemMergeMode: "always",
        workItemAutoMergeOverride: false,
      }),
    ).toBe("always")
  })
})

describe("encodeWorkItemMergePolicyPin", () => {
  it("encodes each pin so decode recovers it", () => {
    for (const pin of ["always", "classify", "off"] as const) {
      const encoded = encodeWorkItemMergePolicyPin(pin)
      expect(
        decodeWorkItemMergePolicy({
          workItemMergeMode: encoded.mergeMode,
          workItemAutoMergeOverride: encoded.autoMergeOverride,
        }),
      ).toBe(pin)
    }
  })
})

describe("resolveEffectiveMergePolicy", () => {
  it("lets a Work Item pin disagree with the live Repository Merge Policy", () => {
    expect(
      resolveEffectiveMergePolicy({
        repositoryMergePolicy: "classify",
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: false,
      }),
    ).toBe("off")
    expect(
      resolveEffectiveMergePolicy({
        repositoryMergePolicy: "off",
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: true,
      }),
    ).toBe("classify")
    expect(
      resolveEffectiveMergePolicy({
        repositoryMergePolicy: "always",
        workItemMergeMode: "ordinary",
        workItemAutoMergeOverride: null,
      }),
    ).toBe("always")
    expect(
      resolveEffectiveMergePolicy({
        repositoryMergePolicy: "off",
        workItemMergeMode: "always",
        workItemAutoMergeOverride: null,
      }),
    ).toBe("always")
  })
})

describe("decidePrMerge", () => {
  it("continues the Implement Session and returns OpenCode's merge decision", async () => {
    let prompt = ""
    let sessionId = ""
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: (input) => {
          prompt = input.prompt
          sessionId = input.sessionId
          return Effect.succeed({
            sessionId: input.sessionId,
            assistantText: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          })
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "clanker_merge" })
    expect(sessionId).toBe("ses_implement")
    expect(prompt).toContain("CLANKER_MERGE")
    expect(prompt).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
  })

  it("uses ambient gh guidance when the backend lacks KeymaxxerMcp", async () => {
    let prompt = ""
    let findSecretCalled = false
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: (input) => {
          prompt = input.prompt
          return Effect.succeed({
            sessionId: input.sessionId,
            assistantText: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          })
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "grok" as const, label: "Grok Build" },
            models: [],
          }),
      }),
    )
    const vaultOn = Layer.succeed(KeymaxxerService, {
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
    } satisfies KeymaxxerServiceShape)

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            vaultOn,
            agentBackend,
            stubGrokActiveAgentBackendLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "clanker_merge" })
    expect(findSecretCalled).toBe(false)
    expect(prompt.toLowerCase()).not.toContain("keymaxxer")
    expect(prompt).toContain(
      "Use the gh CLI with the existing ambient authentication",
    )
  })

  it("uses ambient gh guidance when Keymaxxer is disabled on a capable backend", async () => {
    let prompt = ""
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: (input) => {
          prompt = input.prompt
          return Effect.succeed({
            sessionId: input.sessionId,
            assistantText: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          })
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )
    const disabled = Layer.succeed(KeymaxxerService, {
      enabled: false,
      initialize: Effect.void,
      hasSecret: () => Effect.succeed(false),
      findSecret: () => Effect.die("must not inspect the vault"),
      findSecrets: () => Effect.succeed([]),
      addSecret: () => Effect.succeed(false),
      runWithSecrets: () =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    } satisfies KeymaxxerServiceShape)

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            disabled,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "clanker_merge" })
    expect(prompt.toLowerCase()).not.toContain("keymaxxer")
    expect(prompt).toContain(
      "Use the gh CLI with the existing ambient authentication",
    )
  })

  it("returns a human intervention reason when risk is high", async () => {
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: () =>
          Effect.succeed({
            sessionId: "ses_implement",
            assistantText:
              "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: Migrates production data",
          }),
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Migrates production data",
    })
  })

  it("skips OpenCode when auto-merge is disabled", async () => {
    const pausedRepoDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([{ ...repository, mergePolicy: "off" }]),
    })
    let continued = false
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: () => {
          continued = true
          return Effect.die("should not run")
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            pausedRepoDb,
            keymaxxer,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(continued).toBe(false)
    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Auto-merge is disabled for this repository",
    })
  })

  it("skips the merge-risk Agent Turn when the Work Item override is false", async () => {
    let continued = false
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: () => {
          continued = true
          return Effect.die("should not run")
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge({ ...context, autoMergeOverride: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(continued).toBe(false)
    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Auto-merge is disabled for this Work Item",
    })
  })

  it("runs risk assessment when the Work Item override is true and Repository Auto-merge is false", async () => {
    const disabledRepoDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([{ ...repository, mergePolicy: "off" }]),
    })
    let continued = false
    const agentBackend = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => Effect.die("unused"),
        continueTurn: () => {
          continued = true
          return Effect.succeed({
            sessionId: "ses_implement",
            assistantText: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          })
        },
        inspect: () =>
          Effect.succeed({
            backend: { id: "opencode" as const, label: "OpenCode" },
            models: [],
          }),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge({ ...context, autoMergeOverride: true }).pipe(
        Effect.provide(
          Layer.mergeAll(
            disabledRepoDb,
            keymaxxer,
            agentBackend,
            stubActiveAgentBackendLayer(),
          ),
        ),
      ),
    )

    expect(continued).toBe(true)
    expect(result).toEqual({ _tag: "clanker_merge" })
  })
})
