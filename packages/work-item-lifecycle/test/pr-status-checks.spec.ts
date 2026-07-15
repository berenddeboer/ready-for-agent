import { Effect, Layer } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import {
  type LifecycleStepContext,
  investigatePrStatusChecks,
  makeWorkItemId,
  watchPrStatusChecks,
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

describe("PR status check steps", () => {
  it("checks the deterministic Work Item branch", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getPullRequestCheckStatus: (_repository, branch) => {
        requestedBranch = branch
        return Effect.succeed({ _tag: "pending" })
      },
    } satisfies GitHubServiceShape)

    const status = await Effect.runPromise(
      watchPrStatusChecks(context).pipe(
        Effect.provide(Layer.merge(db, github)),
      ),
    )

    expect(status).toBe("pending")
    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("returns OpenCode's structured human intervention reason", async () => {
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
            text: "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: A maintainer must approve deployment",
          })}\n`,
          stderr: "",
        })
      },
    } satisfies KeymaxxerServiceShape)

    const result = await Effect.runPromise(
      investigatePrStatusChecks(context).pipe(
        Effect.provide(Layer.merge(db, keymaxxer)),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "A maintainer must approve deployment",
    })
    expect(command).toContain('GH_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"')
    expect(command).toContain("'--session' 'ses_implement'")
  })
})
