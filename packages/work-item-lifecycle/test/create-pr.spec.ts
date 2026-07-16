import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import type { DbService } from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerError,
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CreatePrCredentialError,
  CreatePrInvalidWorktreeContextError,
  CreatePrOpenCodeError,
  CreatePrSessionContextMissingError,
  CreatePrWorktreeContextMissingError,
  createPr,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 91,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubDb = stubDbServiceLayer({
  listRepositories: Effect.succeed([
    makeRepositoryRecord({ localPath: "/repos/acme-widgets" }),
  ]),
})

const stubKeymaxxer = (
  overrides: Partial<KeymaxxerServiceShape> = {},
): Layer.Layer<KeymaxxerService> =>
  Layer.succeed(KeymaxxerService, {
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(true),
    findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
    findSecrets: () => Effect.succeed([]),
    addSecret: () => Effect.succeed(true),
    removeSecret: () => Effect.succeed(true),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  })

const stubGitHub = (
  overrides: Partial<GitHubServiceShape> = {},
): Layer.Layer<GitHubService> =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      getOpenPullRequestNumber: () => Effect.succeed(321),
      getPullRequestCheckStatus: () =>
        Effect.succeed({ _tag: "succeeded", terminalChecks: [] }),
      markPullRequestReadyForReview: () => Effect.void,
      listReadyIssues: () => Effect.succeed([]),
      ...overrides,
    }),
  )

const stubOpencode = (
  overrides: {
    continue?: (input: {
      sessionId: string
      prompt: string
      cwd: string
      model: string
      variant: string
      timeout?: Duration.Input
    }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  } = {},
) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: () =>
        Effect.succeed({ sessionId: "ses_start_unused", assistantText: "" }),
      continue:
        overrides.continue ??
        (() =>
          Effect.succeed({
            sessionId: "ses_implement_session",
            assistantText: "",
          })),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    DbService | GitHubService | KeymaxxerService | Opencode
  >,
  layers: {
    keymaxxer?: Layer.Layer<KeymaxxerService>
    opencode?: Layer.Layer<Opencode>
    github?: Layer.Layer<GitHubService>
  } = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          stubDb,
          layers.github ?? stubGitHub(),
          layers.keymaxxer ?? stubKeymaxxer(),
          layers.opencode ?? stubOpencode(),
        ),
      ),
      Effect.provide(PlatformLayer),
    ),
  )

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-create-pr-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("createPr", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(createPr(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CreatePrWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-create-pr-missing-worktree")
    const error = await run(createPr(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CreatePrInvalidWorktreeContextError)
  })

  it("rejects missing Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root, { sessionId: null })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CreatePrSessionContextMissingError)
    }))

  it("rejects blank Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root, { sessionId: "   " })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CreatePrSessionContextMissingError)
    }))

  it("continues OpenCode directly after pre-flight credential lookup", () =>
    withTemp(async (root) => {
      let credentialAccount: string | null = null
      let continueInput: {
        sessionId: string
        prompt: string
        cwd: string
        model: string
        variant: string
      } | null = null
      let resolvedBranch: string | null = null

      const pullRequestNumber = await run(
        createPr(
          baseContext(root, {
            sessionId: "ses_from_implement",
            githubIssueNumber: 2039,
            model: "opencode/create-pr-model",
            variant: "max",
            reviewModel: "opencode/create-pr-model",
            reviewVariant: "max",
            maxDuration: Duration.minutes(12),
          }),
        ),
        {
          keymaxxer: stubKeymaxxer({
            findSecret: ({ account }) => {
              credentialAccount = account
              return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
            },
          }),
          opencode: stubOpencode({
            continue: (input) => {
              continueInput = input
              return Effect.succeed({
                sessionId: input.sessionId,
                assistantText: "",
              })
            },
          }),
          github: stubGitHub({
            getOpenPullRequestNumber: (_repository, branch) => {
              resolvedBranch = branch
              return Effect.succeed(321)
            },
          }),
        },
      )

      expect(pullRequestNumber).toBe(321)
      expect(resolvedBranch).toContain("/2039/")
      expect(credentialAccount).toBe("acme/widgets")
      expect(continueInput).not.toBeNull()
      expect(continueInput!.cwd).toBe(root)
      expect(continueInput!.sessionId).toBe("ses_from_implement")
      expect(continueInput!.model).toBe("opencode/create-pr-model")
      expect(continueInput!.variant).toBe("max")
      expect(continueInput!.prompt).toContain("GitHub issue #2039")
      expect(continueInput!.prompt).toContain("Closes #2039")
      expect(continueInput!.prompt).toContain(
        "Create the pull request as a draft",
      )
      expect(continueInput!.prompt).toContain(
        "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
      )
    }))

  it("rejects a missing repository credential", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        keymaxxer: stubKeymaxxer({
          findSecret: () => Effect.succeed(null),
        }),
      })
      expect(error).toBeInstanceOf(CreatePrCredentialError)
      expect((error as CreatePrCredentialError).message).toContain(
        "No GitHub credential is configured for acme/widgets",
      )
    }))

  it("maps Keymaxxer credential lookup failure", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        keymaxxer: stubKeymaxxer({
          findSecret: () =>
            Effect.fail(
              new KeymaxxerError({
                operation: "findSecret",
                message: "vault unavailable",
              }),
            ),
        }),
      })
      expect(error).toBeInstanceOf(CreatePrCredentialError)
    }))

  it("maps OpenCode failure", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        opencode: Layer.succeed(
          Opencode,
          Opencode.of({
            start: () => Effect.die("unused"),
            continue: () =>
              Effect.fail({
                _tag: "OpencodeExitError",
                exitCode: 2,
                cwd: root,
              } as never),
            listModels: () => Effect.succeed([]),
          }),
        ),
      })
      expect(error).toBeInstanceOf(CreatePrOpenCodeError)
    }))
})
