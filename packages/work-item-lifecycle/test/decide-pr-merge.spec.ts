import { Effect, Layer } from "effect"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  type LifecycleStepContext,
  decidePrMerge,
  makeWorkItemId,
  parseDecidePrMergeResult,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({
  localPath: "/repos/widgets",
  autoMerge: true,
})

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  worktreePath: "/tmp/worktree",
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

describe("decidePrMerge", () => {
  it("continues the Implement Session and returns OpenCode's merge decision", async () => {
    let prompt = ""
    let sessionId = ""
    const opencode = Layer.succeed(
      Opencode,
      Opencode.of({
        start: () => Effect.die("unused"),
        continue: (input) => {
          prompt = input.prompt
          sessionId = input.sessionId
          return Effect.succeed({
            sessionId: input.sessionId,
            assistantText: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
          })
        },
        listModels: () => Effect.succeed([]),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(Layer.mergeAll(db, keymaxxer, opencode)),
      ),
    )

    expect(result).toEqual({ _tag: "clanker_merge" })
    expect(sessionId).toBe("ses_implement")
    expect(prompt).toContain("CLANKER_MERGE")
    expect(prompt).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
  })

  it("returns a human intervention reason when risk is high", async () => {
    const opencode = Layer.succeed(
      Opencode,
      Opencode.of({
        start: () => Effect.die("unused"),
        continue: () =>
          Effect.succeed({
            sessionId: "ses_implement",
            assistantText:
              "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: Migrates production data",
          }),
        listModels: () => Effect.succeed([]),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(Layer.mergeAll(db, keymaxxer, opencode)),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Migrates production data",
    })
  })

  it("skips OpenCode when auto-merge is disabled", async () => {
    const pausedRepoDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([{ ...repository, autoMerge: false }]),
    })
    let continued = false
    const opencode = Layer.succeed(
      Opencode,
      Opencode.of({
        start: () => Effect.die("unused"),
        continue: () => {
          continued = true
          return Effect.die("should not run")
        },
        listModels: () => Effect.succeed([]),
      }),
    )

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(
        Effect.provide(Layer.mergeAll(pausedRepoDb, keymaxxer, opencode)),
      ),
    )

    expect(continued).toBe(false)
    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Auto-merge is disabled for this repository",
    })
  })
})
