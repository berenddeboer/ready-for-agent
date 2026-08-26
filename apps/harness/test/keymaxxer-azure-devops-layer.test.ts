import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
  AzureDevOpsService,
} from "@ready-for-agent/azure-devops-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerAzureDevOpsLayer } from "../src/server/keymaxxer-azure-devops-layer.js"

const platformLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const azureLifecycleStub = {
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  ensurePullRequestLinkedToIssue: () => Effect.void,
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded" as const,
      terminalChecks: [],
      mergeability: "mergeable" as const,
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  markPullRequestReadyForReview: () => Effect.void,
  getPullRequestLifecycleStatus: () =>
    Effect.succeed({ _tag: "open" as const }),
  mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
} as const

const repository = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
} as const

const vaultAccount = "acme/widgets"

describe("Keymaxxer-backed Azure DevOps layer", () => {
  it.effect(
    "does not prompt Keymaxxer when a repository token is missing and falls back to ambient",
    () =>
      Effect.gen(function* () {
        let addCalled = false
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed(null),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () =>
            Effect.sync(() => {
              addCalled = true
              return true
            }),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
          },
        })
        const layer = keymaxxerAzureDevOpsLayer({
          workspaceRoot: "/workspace",
          environment: { AZURE_DEVOPS_EXT_PAT: "ambient-token" },
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        yield* Effect.gen(function* () {
          const azureDevOps = yield* AzureDevOpsService
          expect(yield* azureDevOps.hasCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))

        expect(addCalled).toBe(false)
        expect(runs).toHaveLength(0)
      }),
  )

  it.effect("selects vault secrets by project-path account", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const tokens = new Map([
        ["acme/widgets", "AZURE_DEVOPS_TOKEN_ACME_WIDGETS"],
        ["other/project", "AZURE_DEVOPS_TOKEN_OTHER_PROJECT"],
      ])
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(tokens.get(account) ?? null),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
        },
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        yield* azureDevOps.listReadyIssues(repository)
        yield* azureDevOps.listReadyIssues({
          forge: "azure-devops",
          forgeHost: "dev.azure.com",
          projectPath: "other/project",
        })
      }).pipe(Effect.provide(layer))

      expect(runs.map(({ secrets }) => secrets)).toEqual([
        ["AZURE_DEVOPS_TOKEN_ACME_WIDGETS"],
        ["AZURE_DEVOPS_TOKEN_OTHER_PROJECT"],
      ])
      for (const run of runs) {
        expect(run.command).toContain('AZURE_DEVOPS_EXT_PAT="$')
        expect(run.command).toMatch(/list-ready-issues/)
      }
    }),
  )

  it.effect(
    "vault secret takes precedence over ambient AZURE_DEVOPS_EXT_PAT",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ provider, account }) =>
            Effect.succeed(
              provider === "azure-devops" && account === vaultAccount
                ? "AZURE_DEVOPS_TOKEN_ACME_WIDGETS"
                : null,
            ),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  number: 7,
                  title: "Ready issue",
                  body: "Issue body",
                  url: "https://dev.azure.com/acme/widgets/_workitems/edit/7",
                  createdAt: "2026-07-07T12:00:00.000Z",
                  state: "OPEN",
                  author: "alice",
                  hierarchySupported: false,
                  closingPullRequests: [],
                  hasChildren: false,
                  parentPosition: null,
                  parent: null,
                  blockedBy: [],
                },
              ]),
              stderr: "",
            })
          },
        })
        const layer = keymaxxerAzureDevOpsLayer({
          workspaceRoot: "/workspace",
          environment: { AZURE_DEVOPS_EXT_PAT: "must-not-be-used-in-harness" },
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const issues = yield* Effect.gen(function* () {
          const azureDevOps = yield* AzureDevOpsService
          return yield* azureDevOps.listReadyIssues(repository)
        }).pipe(Effect.provide(layer))

        expect(issues).toHaveLength(1)
        expect(issues[0]!.number).toBe(7)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.secrets).toEqual(["AZURE_DEVOPS_TOKEN_ACME_WIDGETS"])
        expect(runs[0]!.command).toContain(
          'AZURE_DEVOPS_EXT_PAT="$AZURE_DEVOPS_TOKEN_ACME_WIDGETS"',
        )
      }),
  )

  it.effect("hasCredentials is true when vault holds the secret", () =>
    Effect.gen(function* () {
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount ? "AZURE_DEVOPS_TOKEN_ACME_WIDGETS" : null,
          ),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () => Effect.die("not used"),
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        expect(yield* azureDevOps.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("maps helper exit code 2 to project unavailable", () =>
    Effect.gen(function* () {
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("AZURE_DEVOPS_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 2, stdout: "", stderr: "" }),
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      const error = yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        return yield* Effect.flip(azureDevOps.listReadyIssues(repository))
      }).pipe(Effect.provide(layer))

      expect(error).toBeInstanceOf(AzureDevOpsProjectUnavailableError)
    }),
  )

  it.effect(
    "hasCredentials fails open when vault is unavailable and ambient is absent",
    () =>
      Effect.gen(function* () {
        let ambientChecked = false
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () =>
            Effect.fail(keymaxxerError("findSecret", "sidecar unavailable")),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () => Effect.die("not used"),
        })
        const layer = keymaxxerAzureDevOpsLayer({
          workspaceRoot: "/workspace",
          makeService: () => ({
            verifyProject: (candidate) => Effect.succeed(candidate),
            getAuthenticatedUserLogin: () => Effect.succeed("operator"),
            listReadyIssues: () => Effect.succeed([]),
            hasCredentials: () =>
              Effect.sync(() => {
                ambientChecked = true
                return false
              }),
            hasAmbientCredentials: () =>
              Effect.sync(() => {
                ambientChecked = true
                return false
              }),
            ...azureLifecycleStub,
          }),
          makeAnonymousService: () => ({
            verifyProject: (candidate) => Effect.succeed(candidate),
            getAuthenticatedUserLogin: () => Effect.succeed("anonymous"),
            listReadyIssues: () => Effect.succeed([]),
            hasCredentials: () => Effect.succeed(false),
            hasAmbientCredentials: () => Effect.succeed(false),
            ...azureLifecycleStub,
          }),
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        yield* Effect.gen(function* () {
          const azureDevOps = yield* AzureDevOpsService
          expect(yield* azureDevOps.hasCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))
        expect(ambientChecked).toBe(false)
      }),
  )

  it.effect("creates a draft pull request through the vault secret", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount ? "AZURE_DEVOPS_TOKEN_ACME_WIDGETS" : null,
          ),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({ exitCode: 0, stdout: "42", stderr: "" })
        },
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      const number = yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        return yield* azureDevOps.createDraftPullRequest(repository, {
          headRefName: "rfa/acme-widgets/7/wi-test",
          title: "Ready issue",
          body: "Closes #7",
        })
      }).pipe(Effect.provide(layer))

      expect(number).toBe(42)
      expect(runs[0]?.command).toContain("create-draft-pull-request")
      expect(runs[0]?.command).toContain('AZURE_DEVOPS_EXT_PAT="$')
      expect(runs[0]?.secrets).toEqual(["AZURE_DEVOPS_TOKEN_ACME_WIDGETS"])
    }),
  )

  it.effect("merges a pull request through the vault secret", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount ? "AZURE_DEVOPS_TOKEN_ACME_WIDGETS" : null,
          ),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({ _tag: "merged" }),
            stderr: "",
          })
        },
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      const result = yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        return yield* azureDevOps.mergePullRequest(
          repository,
          "rfa/acme-widgets/7/wi-test",
        )
      }).pipe(Effect.provide(layer))

      expect(result).toEqual({ _tag: "merged" })
      expect(runs[0]?.command).toContain("merge-pull-request")
      expect(runs[0]?.secrets).toEqual(["AZURE_DEVOPS_TOKEN_ACME_WIDGETS"])
    }),
  )

  it.effect("completes an issue through the vault secret", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount ? "AZURE_DEVOPS_TOKEN_ACME_WIDGETS" : null,
          ),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" })
        },
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        yield* azureDevOps.ensureIssueCompletedWithSummary(
          repository,
          7,
          "wi-test",
          "Done.",
        )
      }).pipe(Effect.provide(layer))

      expect(runs[0]?.command).toContain("ensure-issue-completed-with-summary")
      expect(runs[0]?.secrets).toEqual(["AZURE_DEVOPS_TOKEN_ACME_WIDGETS"])
    }),
  )

  it.effect(
    "helper KeymaxxerError after a resolved secret stays fail-closed",
    () =>
      Effect.gen(function* () {
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("AZURE_DEVOPS_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.fail(keymaxxerError("runWithSecrets", "use denied")),
        })
        const layer = keymaxxerAzureDevOpsLayer({
          workspaceRoot: "/workspace",
          environment: { AZURE_DEVOPS_EXT_PAT: "must-not-fallback" },
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const error = yield* Effect.gen(function* () {
          const azureDevOps = yield* AzureDevOpsService
          return yield* Effect.flip(azureDevOps.listReadyIssues(repository))
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(AzureDevOpsRequestError)
        expect(error.message).toContain("list Ready-labeled Issues")
      }),
  )

  it.effect("operations fall through to ambient when vault lookup fails", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      let ambientListCalls = 0
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () =>
          Effect.fail(keymaxxerError("findSecret", "sidecar unavailable")),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
        },
      })
      const layer = keymaxxerAzureDevOpsLayer({
        workspaceRoot: "/workspace",
        environment: { AZURE_DEVOPS_EXT_PAT: "ambient-token" },
        makeService: () => ({
          verifyProject: (candidate) => Effect.succeed(candidate),
          getAuthenticatedUserLogin: () => Effect.succeed("operator"),
          listReadyIssues: () => {
            ambientListCalls += 1
            return Effect.succeed([])
          },
          hasCredentials: () => Effect.succeed(true),
          hasAmbientCredentials: () => Effect.succeed(true),
          ...azureLifecycleStub,
        }),
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      yield* Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        expect(yield* azureDevOps.listReadyIssues(repository)).toEqual([])
      }).pipe(Effect.provide(layer))
      expect(runs).toHaveLength(0)
      expect(ambientListCalls).toBe(1)
    }),
  )
})
