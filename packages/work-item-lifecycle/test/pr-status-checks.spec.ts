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
import { Opencode } from "@ready-for-agent/opencode"
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

const keymaxxer = Layer.succeed(KeymaxxerService, {
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(true),
  findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies KeymaxxerServiceShape)

describe("PR status check steps", () => {
  it("checks the deterministic Work Item branch", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getPullRequestCheckStatus: (_repository, branch) => {
        requestedBranch = branch
        return Effect.succeed({ _tag: "pending" })
      },
      markPullRequestReadyForReview: () => Effect.void,
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
            assistantText:
              "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: A maintainer must approve deployment",
          })
        },
        listModels: () => Effect.succeed([]),
      }),
    )

    const result = await Effect.runPromise(
      investigatePrStatusChecks(context).pipe(
        Effect.provide(Layer.mergeAll(db, keymaxxer, opencode)),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "A maintainer must approve deployment",
    })
    expect(sessionId).toBe("ses_implement")
    expect(prompt).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
  })
})
