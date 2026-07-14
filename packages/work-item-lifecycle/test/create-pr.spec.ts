import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { DbService, type DbServiceShape } from "@ready-for-agent/db-service"
import {
  KeymaxxerError,
  KeymaxxerService,
  type KeymaxxerServiceShape,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
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
  worktreePath,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubDb = Layer.succeed(DbService, {
  listRepositories: Effect.succeed([
    {
      id: "repo-test",
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: "/repos/acme-widgets",
      isBare: true,
      paused: false,
      issuesReconciledAt: null,
    },
  ]),
} as DbServiceShape)

const stubKeymaxxer = (
  overrides: Partial<KeymaxxerServiceShape> = {},
): Layer.Layer<KeymaxxerService> =>
  Layer.succeed(KeymaxxerService, {
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(true),
    findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
    findSecrets: () => Effect.succeed([]),
    addSecret: () => Effect.succeed(true),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, DbService | KeymaxxerService>,
  keymaxxerLayer: Layer.Layer<KeymaxxerService> = stubKeymaxxer(),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(stubDb, keymaxxerLayer)),
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

  it("runs the OpenCode continuation through Keymaxxer with the repository credential", () =>
    withTemp(async (root) => {
      let runInput: RunWithSecretsInput | null = null
      let credentialAccount: string | null = null

      await run(
        createPr(
          baseContext(root, {
            sessionId: "ses_from_implement",
            githubIssueNumber: 2039,
            model: "opencode/create-pr-model",
            variant: "max",
            maxDuration: Duration.minutes(12),
          }),
        ),
        stubKeymaxxer({
          findSecret: ({ account }) => {
            credentialAccount = account
            return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
          },
          runWithSecrets: (input) => {
            runInput = input
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
      )

      expect(credentialAccount).toBe("acme/widgets")
      expect(runInput).not.toBeNull()
      expect(runInput!.cwd).toBe(root)
      expect(runInput!.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      expect(runInput!.timeoutMs).toBe(Duration.toMillis(Duration.minutes(12)))
      expect(runInput!.command).toStartWith(
        'GH_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS" GITHUB_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"',
      )
      expect(runInput!.command).toContain("'opencode' 'run' '--auto'")
      expect(runInput!.command).toContain("'--session' 'ses_from_implement'")
      expect(runInput!.command).toContain("GitHub issue #2039")
      expect(runInput!.command).toContain("Closes #2039")
      expect(runInput!.command).toContain("Do not merge the pull request")
    }))

  it("rejects a missing repository credential", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root)).pipe(Effect.flip),
        stubKeymaxxer({ findSecret: () => Effect.succeed(null) }),
      )
      expect(error).toBeInstanceOf(CreatePrCredentialError)
      expect((error as CreatePrCredentialError).message).toContain(
        "No GitHub credential is configured for acme/widgets",
      )
    }))

  it("maps Keymaxxer credential lookup failure", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root)).pipe(Effect.flip),
        stubKeymaxxer({
          findSecret: () =>
            Effect.fail(
              new KeymaxxerError({
                operation: "findSecret",
                message: "vault unavailable",
              }),
            ),
        }),
      )
      expect(error).toBeInstanceOf(CreatePrCredentialError)
    }))

  it("maps Keymaxxer process failure", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root)).pipe(Effect.flip),
        stubKeymaxxer({
          runWithSecrets: () =>
            Effect.fail(
              new KeymaxxerError({
                operation: "runWithSecrets",
                message: "process failed",
              }),
            ),
        }),
      )
      expect(error).toBeInstanceOf(CreatePrOpenCodeError)
    }))

  it("maps a non-zero OpenCode exit", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root)).pipe(Effect.flip),
        stubKeymaxxer({
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 2, stdout: "", stderr: "failed" }),
        }),
      )
      expect(error).toBeInstanceOf(CreatePrOpenCodeError)
      expect((error as CreatePrOpenCodeError).worktreePath).toBe(root)
      expect((error as CreatePrOpenCodeError).sessionId).toBe(
        "ses_implement_session",
      )
    }))
})
