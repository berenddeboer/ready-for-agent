import { Effect, Layer } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import {
  type LifecycleStepContext,
  decidePrMerge,
  makeWorkItemId,
  parseDecidePrMergeResult,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = {
  id: "repo-test",
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/widgets",
  isBare: true,
  paused: false,
  issuesReconciledAt: null,
}

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  worktreePath: "/tmp/worktree",
  sessionId: "ses_implement",
}

const db = Layer.succeed(DbService, {
  listRepositories: Effect.succeed([repository]),
} as DbServiceShape)

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
    let command = ""
    const keymaxxer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      hasSecret: () => Effect.succeed(true),
      findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      findSecrets: () => Effect.succeed([]),
      addSecret: () => Effect.succeed(true),
      runWithSecrets: (input) => {
        command = input.command
        return Effect.succeed({
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: "text",
            part: {
              type: "text",
              text: "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
            },
          })}\n`,
          stderr: "",
        })
      },
    } satisfies KeymaxxerServiceShape)

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(Effect.provide(Layer.merge(db, keymaxxer))),
    )

    expect(result).toEqual({ _tag: "clanker_merge" })
    expect(command).toContain('GH_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"')
    expect(command).toContain("'--session' 'ses_implement'")
    expect(command).toContain("CLANKER_MERGE")
    expect(command).toEndWith(" </dev/null")
  })

  it("returns a human intervention reason when risk is high", async () => {
    const keymaxxer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      hasSecret: () => Effect.succeed(true),
      findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      findSecrets: () => Effect.succeed([]),
      addSecret: () => Effect.succeed(true),
      runWithSecrets: () =>
        Effect.succeed({
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: "text",
            part: {
              type: "text",
              text: "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: Migrates production data",
            },
          })}\n`,
          stderr: "",
        }),
    } satisfies KeymaxxerServiceShape)

    const result = await Effect.runPromise(
      decidePrMerge(context).pipe(Effect.provide(Layer.merge(db, keymaxxer))),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "Migrates production data",
    })
  })
})
