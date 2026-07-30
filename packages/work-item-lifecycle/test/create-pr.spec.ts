import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import {
  type ActiveAgentBackend,
  AgentBackend,
} from "@ready-for-agent/agent-backend"
import type { DbService } from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
  testRepositoryId,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerError,
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CreatePrCredentialError,
  CreatePrInvalidWorktreeContextError,
  CreatePrOpenCodeError,
  CreatePrPostconditionError,
  CreatePrSessionContextMissingError,
  CreatePrWorktreeContextMissingError,
  buildDeterministicPullRequestBody,
  buildDeterministicPullRequestTitle,
  createPr,
  makeWorkItemId,
  stubActiveAgentBackendLayer,
  stubGrokActiveAgentBackendLayer,
  workItemBranchName,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: testRepositoryId,
  issueNumber: 91,
  issueTitle: "Add widgets endpoint",
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: "feat: add widgets endpoint",
  publicationBody:
    "Adds the widgets HTTP endpoint used by the dashboard.\n\nVerified with unit tests.\n\nCloses #91",
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
      findOpenPullRequestNumber: () => Effect.succeed(null),
      createDraftPullRequest: () => Effect.succeed(321),
      updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      ...overrides,
    }),
  )

const stubGitLab = (
  overrides: Partial<GitLabServiceShape> = {},
): Layer.Layer<GitLabService> =>
  Layer.succeed(GitLabService, {
    verifyProject: (repository) => Effect.succeed(repository),
    getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
    listReadyIssues: () => Effect.succeed([]),
    hasCredentials: () => Effect.succeed(true),
    hasAmbientCredentials: () => Effect.succeed(true),
    getOpenPullRequestNumber: () => Effect.succeed(321),
    findOpenPullRequestNumber: () => Effect.succeed(null),
    createDraftPullRequest: () => Effect.succeed(321),
    updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    getPullRequestCheckStatus: () =>
      Effect.succeed({
        _tag: "succeeded",
        terminalChecks: [],
        mergeability: "mergeable",
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
    ...overrides,
  } satisfies GitLabServiceShape)

const stubOpencode = (
  overrides: {
    continueTurn?: (input: {
      sessionId: string
      prompt: string
      cwd: string
      model: string
      thinkingLevel: string | null
      timeout?: Duration.Input
    }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  } = {},
) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: () =>
        Effect.succeed({ sessionId: "ses_start_unused", assistantText: "" }),
      continueTurn:
        overrides.continueTurn ??
        (() =>
          Effect.succeed({
            sessionId: "ses_implement_session",
            assistantText: "",
          })),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | DbService
    | GitHubService
    | GitLabService
    | KeymaxxerService
    | AgentBackend
    | ActiveAgentBackend
  >,
  layers: {
    db?: Layer.Layer<DbService>
    keymaxxer?: Layer.Layer<KeymaxxerService>
    opencode?: Layer.Layer<AgentBackend>
    github?: Layer.Layer<GitHubService>
    gitlab?: Layer.Layer<GitLabService>
    activeBackend?: Layer.Layer<ActiveAgentBackend>
  } = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          layers.db ?? stubDb,
          layers.github ?? stubGitHub(),
          layers.gitlab ?? stubGitLab(),
          layers.keymaxxer ?? stubKeymaxxer(),
          layers.opencode ?? stubOpencode(),
          layers.activeBackend ?? stubActiveAgentBackendLayer(),
        ),
      ),
      Effect.provide(PlatformLayer),
    ),
  )

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-create-pr-"))
  try {
    // Minimal git repo so push can fail deterministically without a remote.
    const proc = Bun.spawn(
      ["git", "-c", "commit.gpgsign=false", "init", "-b", "main"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    await proc.exited
    await writeFile(join(root, "README.md"), "# test\n")
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("deterministic PR templates", () => {
  it("builds title and body with closing semantics", () => {
    expect(
      buildDeterministicPullRequestTitle({
        issueNumber: 91,
        issueTitle: "Add widgets",
      }),
    ).toBe("Add widgets")
    expect(buildDeterministicPullRequestBody(91)).toContain("Closes #91")
  })
})

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

  it("creates a draft GitLab MR without calling GitHub", () =>
    withTemp(async (root) => {
      let githubCalls = 0
      let created: {
        headRefName: string
        title: string
        body: string
      } | null = null
      const pushCommands: string[] = []
      let agentCalls = 0
      const gitlabDb = stubDbServiceLayer({
        listRepositories: Effect.succeed([
          makeRepositoryRecord({
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/widgets",
            localPath: "/repos/project-widgets",
          }),
        ]),
      })
      const context = baseContext(root, {
        issueNumber: 3601642,
        publicationTitle: "feat: refresh tokens",
        publicationBody: "Implements refresh.\n\nCloses #3601642",
      })
      const expectedBranch = workItemBranchName({
        projectPath: "project/widgets",
        issueNumber: 3601642,
        workItemId: context.workItemId,
      })

      const result = await run(createPr(context), {
        db: gitlabDb,
        github: stubGitHub({
          findOpenPullRequestNumber: () => {
            githubCalls += 1
            return Effect.succeed(null)
          },
          createDraftPullRequest: () => {
            githubCalls += 1
            return Effect.succeed(1)
          },
        }),
        gitlab: stubGitLab({
          findOpenPullRequestNumber: () => Effect.succeed(null),
          createDraftPullRequest: (_repository, input) => {
            created = input
            return Effect.succeed(91)
          },
          updateOpenDraftPullRequestCopy: () => Effect.succeed(91),
        }),
        keymaxxer: stubKeymaxxer({
          enabled: true,
          findSecret: (input) => {
            expect(input).toEqual({
              provider: "gitlab",
              account: "git.drupalcode.org/project/widgets",
            })
            return Effect.succeed("GITLAB_TOKEN_PROJECT_WIDGETS")
          },
          runWithSecrets: (input) => {
            pushCommands.push(input.command)
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
        opencode: stubOpencode({
          continueTurn: () => {
            agentCalls += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "",
            })
          },
        }),
      })

      expect(result).toMatchObject({
        pullRequestNumber: 91,
        completion: "native",
        publicationTitle: "feat: refresh tokens",
        publicationBody: "Implements refresh.\n\nCloses #3601642",
      })
      expect(created).toEqual({
        headRefName: expectedBranch,
        title: "feat: refresh tokens",
        body: "Implements refresh.\n\nCloses #3601642",
      })
      expect(githubCalls).toBe(0)
      expect(agentCalls).toBe(0)
      expect(pushCommands).toHaveLength(1)
      const pushCommand = pushCommands[0]!
      expect(pushCommand).toContain(
        "https://git.drupalcode.org/project/widgets.git",
      )
      expect(pushCommand).not.toContain(" origin ")
      expect(pushCommand).toContain("Authorization: Basic $BASIC")
      // Real shell assignment before git — not BASIC=… git … $BASIC prefix form.
      expect(pushCommand).toContain(')" && git ')
    }))
  it("reuses an existing exact-branch open GitLab MR without creation", () =>
    withTemp(async (root) => {
      let createCalls = 0
      let githubCalls = 0
      let reconciled: { title: string; body: string } | null = null
      const gitlabDb = stubDbServiceLayer({
        listRepositories: Effect.succeed([
          makeRepositoryRecord({
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/widgets",
            localPath: "/repos/project-widgets",
          }),
        ]),
      })
      const context = baseContext(root, {
        issueNumber: 3601642,
        publicationTitle: "feat: refresh tokens",
        publicationBody: "Implements refresh.\n\nCloses #3601642",
      })

      const result = await run(createPr(context), {
        db: gitlabDb,
        github: stubGitHub({
          findOpenPullRequestNumber: () => {
            githubCalls += 1
            return Effect.succeed(null)
          },
        }),
        gitlab: stubGitLab({
          findOpenPullRequestNumber: () => Effect.succeed(77),
          createDraftPullRequest: () => {
            createCalls += 1
            return Effect.succeed(91)
          },
          updateOpenDraftPullRequestCopy: (_repository, _branch, input) => {
            reconciled = input
            return Effect.succeed(77)
          },
        }),
        keymaxxer: stubKeymaxxer({
          enabled: false,
          findSecret: () => Effect.succeed(null),
        }),
        opencode: stubOpencode({
          continueTurn: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "",
            }),
        }),
      })

      expect(result).toMatchObject({
        pullRequestNumber: 77,
        completion: "native",
        publicationTitle: "feat: refresh tokens",
      })
      expect(createCalls).toBe(0)
      expect(githubCalls).toBe(0)
      expect(reconciled).toEqual({
        title: "feat: refresh tokens",
        body: "Implements refresh.\n\nCloses #3601642",
      })
    }))

  it("reuses an existing exact-branch open PR without creation or Agent Turn", () =>
    withTemp(async (root) => {
      let createCalls = 0
      let continueCalls = 0
      let resolvedBranch: string | null = null
      let reconciledCopy: { title: string; body: string } | null = null
      const context = baseContext(root, {
        issueNumber: 2039,
        workItemId: makeWorkItemId(),
        publicationTitle: "feat: ship widgets",
        publicationBody: "Ships widgets for the dashboard.\n\nCloses #2039",
      })
      const expectedBranch = workItemBranchName({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
        issueNumber: 2039,
        workItemId: context.workItemId,
      })

      const result = await run(createPr(context), {
        github: stubGitHub({
          findOpenPullRequestNumber: (_repository, branch) => {
            resolvedBranch = branch
            return Effect.succeed(777)
          },
          updateOpenDraftPullRequestCopy: (_repository, _branch, input) => {
            reconciledCopy = input
            return Effect.succeed(777)
          },
          createDraftPullRequest: () => {
            createCalls += 1
            return Effect.succeed(999)
          },
        }),
        opencode: stubOpencode({
          continueTurn: () => {
            continueCalls += 1
            return Effect.succeed({
              sessionId: "ses",
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(777)
      expect(result.completion).toBe("native")
      expect(createCalls).toBe(0)
      expect(continueCalls).toBe(0)
      expect(resolvedBranch).toBe(expectedBranch)
      expect(reconciledCopy).toEqual({
        title: "feat: ship widgets",
        body: "Ships widgets for the dashboard.\n\nCloses #2039",
      })
    }))

  it("reuses an existing open PR when draft copy reconcile fails", () =>
    withTemp(async (root) => {
      let createCalls = 0
      const result = await run(
        createPr(
          baseContext(root, {
            issueNumber: 55,
            publicationTitle: "feat: x",
            publicationBody: "Body for issue 55.\n\nCloses #55",
          }),
        ),
        {
          github: stubGitHub({
            findOpenPullRequestNumber: () => Effect.succeed(55),
            updateOpenDraftPullRequestCopy: () =>
              Effect.fail(
                new GitHubRequestError({ message: "mutation rate limited" }),
              ),
            createDraftPullRequest: () => {
              createCalls += 1
              return Effect.succeed(999)
            },
          }),
        },
      )
      expect(result.pullRequestNumber).toBe(55)
      expect(result.completion).toBe("native")
      expect(createCalls).toBe(0)
    }))

  it("native create succeeds without Agent Backend invocation", () =>
    withTemp(async (root) => {
      let continueCalls = 0
      let createCalls = 0
      let createdInput: {
        headRefName: string
        title: string
        body: string
      } | null = null
      // Push will fail without origin; simulate existing remote by making push
      // succeed is hard. Instead: find returns null first, create is called
      // after push fails... For native success we need push to succeed.
      // Use a fake remote: set push.default and remote via file remote?
      // Simpler: mock isn't available for git push. Use git remote to a bare
      // repo in temp.
      const bare = await mkdtemp(join(tmpdir(), "rfa-create-pr-bare-"))
      try {
        const initBare = Bun.spawn(
          ["git", "init", "--bare", "-b", "main", bare],
          { stdout: "pipe", stderr: "pipe" },
        )
        await initBare.exited
        const addRemote = Bun.spawn(["git", "remote", "add", "origin", bare], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        })
        await addRemote.exited
        // Need a branch matching work item branch with a commit to push.
        const context = baseContext(root, {
          issueNumber: 2039,
          issueTitle: "Ship widgets",
          publicationTitle: "feat: ship widgets",
          publicationBody:
            "Ships the widgets feature end to end.\n\nCloses #2039",
          model: "opencode/create-pr-model",
          thinkingLevel: "max",
          maxDuration: Duration.minutes(12),
        })
        const branch = workItemBranchName({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          issueNumber: 2039,
          workItemId: context.workItemId,
        })
        for (const args of [
          ["config", "user.email", "test@example.com"],
          ["config", "user.name", "Test"],
          ["add", "README.md"],
          ["commit", "--no-verify", "-m", "init"],
          ["checkout", "-b", branch],
        ] as const) {
          const p = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          })
          await p.exited
        }

        let findCalls = 0
        const result = await run(createPr(context), {
          // Ambient push: real git against local bare remote.
          keymaxxer: stubKeymaxxer({
            enabled: false,
            findSecret: () => Effect.die("must not inspect the vault"),
          }),
          github: stubGitHub({
            findOpenPullRequestNumber: () => {
              findCalls += 1
              // Before create: none; after create: exists.
              return Effect.succeed(findCalls >= 2 ? 555 : null)
            },
            createDraftPullRequest: (repository, input) => {
              createCalls += 1
              createdInput = input
              expect(repository).toEqual({
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
              })
              return Effect.succeed(555)
            },
          }),
          opencode: stubOpencode({
            continueTurn: () => {
              continueCalls += 1
              return Effect.succeed({
                sessionId: "ses",
                assistantText: "",
              })
            },
          }),
        })

        expect(result.pullRequestNumber).toBe(555)
        expect(result.completion).toBe("native")
        expect(continueCalls).toBe(0)
        expect(createCalls).toBe(1)
        expect(createdInput).not.toBeNull()
        expect(createdInput!.headRefName).toBe(branch)
        expect(createdInput!.title).toBe("feat: ship widgets")
        expect(createdInput!.body).toContain("Ships the widgets feature")
        expect(createdInput!.body).toContain("Closes #2039")
        expect(createdInput!.body).not.toContain("Automated draft pull request")
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    }))

  it("uses Keymaxxer runWithSecrets for native push when a vault secret is configured", () =>
    withTemp(async (root) => {
      let pushCommand = ""
      let secrets: readonly string[] = []
      let continueCalls = 0

      const context = baseContext(root, { issueNumber: 77 })
      const result = await run(createPr(context), {
        keymaxxer: stubKeymaxxer({
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          runWithSecrets: (input) => {
            pushCommand = input.command
            secrets = input.secrets
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
        github: stubGitHub({
          findOpenPullRequestNumber: () => Effect.succeed(null),
          createDraftPullRequest: () => Effect.succeed(901),
        }),
        opencode: stubOpencode({
          continueTurn: () => {
            continueCalls += 1
            return Effect.succeed({
              sessionId: "ses",
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(901)
      expect(result.completion).toBe("native")
      expect(continueCalls).toBe(0)
      expect(secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      expect(pushCommand).toContain('GH_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"')
      expect(pushCommand).toContain("git")
      expect(pushCommand).toContain("push")
      // Secret-name expansion in the header (not $GH_TOKEN): bash does not
      // apply prefix assignments to later words on the same simple command.
      expect(pushCommand).toContain(
        "http.https://github.com/.extraheader=AUTHORIZATION: bearer $GITHUB_TOKEN_ACME_WIDGETS",
      )
      expect(pushCommand).not.toContain("bearer $GH_TOKEN")
    }))

  it("accepts create number when post-create soft lookup fails", () =>
    withTemp(async (root) => {
      let continueCalls = 0
      let findCalls = 0
      const result = await run(createPr(baseContext(root)), {
        keymaxxer: stubKeymaxxer({
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        }),
        github: stubGitHub({
          findOpenPullRequestNumber: () => {
            findCalls += 1
            if (findCalls === 1) {
              return Effect.succeed(null)
            }
            return Effect.fail(
              new GitHubRequestError({ message: "lookup timeout" }),
            )
          },
          createDraftPullRequest: () => Effect.succeed(444),
        }),
        opencode: stubOpencode({
          continueTurn: () => {
            continueCalls += 1
            return Effect.succeed({
              sessionId: "ses",
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(444)
      expect(result.completion).toBe("native")
      expect(continueCalls).toBe(0)
    }))

  it("treats indeterminate create as success when lookup finds the PR", () =>
    withTemp(async (root) => {
      const bare = await mkdtemp(join(tmpdir(), "rfa-create-pr-bare-"))
      try {
        const initBare = Bun.spawn(
          ["git", "init", "--bare", "-b", "main", bare],
          { stdout: "pipe", stderr: "pipe" },
        )
        await initBare.exited
        await Bun.spawn(["git", "remote", "add", "origin", bare], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        }).exited

        const context = baseContext(root, { issueNumber: 42 })
        const branch = workItemBranchName({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          issueNumber: 42,
          workItemId: context.workItemId,
        })
        for (const args of [
          ["config", "user.email", "test@example.com"],
          ["config", "user.name", "Test"],
          ["add", "README.md"],
          ["commit", "--no-verify", "-m", "init"],
          ["checkout", "-b", branch],
        ] as const) {
          await Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          }).exited
        }

        let continueCalls = 0
        let findPhase = 0
        const result = await run(createPr(context), {
          keymaxxer: stubKeymaxxer({
            enabled: false,
            findSecret: () => Effect.die("must not inspect the vault"),
          }),
          github: stubGitHub({
            // Existence uses findOpenPullRequestNumber (null until after create).
            updateOpenDraftPullRequestCopy: () => Effect.succeed(888),
            findOpenPullRequestNumber: () => {
              findPhase += 1
              // 1: initial existence → none; later soft re-lookup after failed create → found.
              if (findPhase === 1) return Effect.succeed(null)
              return Effect.succeed(888)
            },
            createDraftPullRequest: () =>
              Effect.fail(
                new GitHubRequestError({
                  message: "timeout after create",
                }),
              ),
          }),
          opencode: stubOpencode({
            continueTurn: () => {
              continueCalls += 1
              return Effect.succeed({
                sessionId: "ses",
                assistantText: "",
              })
            },
          }),
        })

        expect(result.pullRequestNumber).toBe(888)
        expect(result.completion).toBe("native")
        expect(continueCalls).toBe(0)
        expect(findPhase).toBeGreaterThanOrEqual(2)
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    }))

  it("falls back to one Agent Turn when native create fails", () =>
    withTemp(async (root) => {
      // Push succeeds via vault stub; draft create fails → fallback.
      let continueInput: {
        sessionId: string
        prompt: string
        cwd: string
        model: string
        thinkingLevel: string | null
      } | null = null
      let agentRan = false

      const context = baseContext(root, {
        sessionId: "ses_from_implement",
        issueNumber: 2039,
        model: "opencode/create-pr-model",
        thinkingLevel: "max",
      })

      const result = await run(createPr(context), {
        github: stubGitHub({
          findOpenPullRequestNumber: () =>
            Effect.succeed(agentRan ? 654 : null),
          createDraftPullRequest: () =>
            Effect.fail(
              new GitHubRequestError({ message: "draft create rejected" }),
            ),
        }),
        opencode: stubOpencode({
          continueTurn: (input) => {
            continueInput = input
            agentRan = true
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(654)
      expect(result.completion).toBe("agent_fallback")
      expect(continueInput).not.toBeNull()
      expect(continueInput!.sessionId).toBe("ses_from_implement")
      expect(continueInput!.cwd).toBe(root)
      expect(continueInput!.model).toBe("opencode/create-pr-model")
      expect(continueInput!.prompt).toContain(
        "Bounded native failure diagnostics",
      )
      expect(continueInput!.prompt).toContain("createDraftPullRequest failed")
      expect(continueInput!.prompt).toContain("Use this exact title and body")
      expect(continueInput!.prompt).toContain(context.publicationTitle!)
      expect(continueInput!.prompt).toContain("Closes #2039")
      expect(continueInput!.prompt).toContain(
        "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
      )
    }))

  it("falls back when ambient push fails with no remote", () =>
    withTemp(async (root) => {
      let agentRan = false
      let prompt = ""
      const result = await run(createPr(baseContext(root)), {
        keymaxxer: stubKeymaxxer({
          enabled: false,
          findSecret: () => Effect.die("must not inspect the vault"),
        }),
        github: stubGitHub({
          findOpenPullRequestNumber: () =>
            Effect.succeed(agentRan ? 111 : null),
        }),
        opencode: stubOpencode({
          continueTurn: (input) => {
            agentRan = true
            prompt = input.prompt
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(111)
      expect(result.completion).toBe("agent_fallback")
      expect(prompt).toContain("git push failed")
    }))

  it("fails when native and fallback both leave no matching PR", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        github: stubGitHub({
          findOpenPullRequestNumber: () => Effect.succeed(null),
          createDraftPullRequest: () =>
            Effect.fail(
              new GitHubRequestError({ message: "create unavailable" }),
            ),
          getOpenPullRequestNumber: () =>
            Effect.fail(
              new GitHubRequestError({ message: "No open pull request found" }),
            ),
        }),
        opencode: stubOpencode({
          continueTurn: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "",
            }),
        }),
      })
      expect(error).toBeInstanceOf(CreatePrPostconditionError)
    }))

  it("requires Session context only for agent fallback", () =>
    withTemp(async (root) => {
      const error = await run(
        createPr(baseContext(root, { sessionId: null })).pipe(Effect.flip),
        {
          github: stubGitHub({
            findOpenPullRequestNumber: () => Effect.succeed(null),
            createDraftPullRequest: () =>
              Effect.fail(
                new GitHubRequestError({ message: "create unavailable" }),
              ),
          }),
        },
      )
      expect(error).toBeInstanceOf(CreatePrSessionContextMissingError)
    }))

  it("rejects a missing repository credential for agent fallback", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        keymaxxer: stubKeymaxxer({
          findSecret: () => Effect.succeed(null),
        }),
        github: stubGitHub({
          findOpenPullRequestNumber: () => Effect.succeed(null),
        }),
      })
      expect(error).toBeInstanceOf(CreatePrCredentialError)
      expect((error as CreatePrCredentialError).message).toContain(
        "No GitHub credential is configured for acme/widgets",
      )
    }))

  it("uses ambient gh guidance when Keymaxxer is disabled on a capable backend", () =>
    withTemp(async (root) => {
      let prompt = ""
      let agentRan = false
      const result = await run(createPr(baseContext(root)), {
        keymaxxer: stubKeymaxxer({
          enabled: false,
          findSecret: () => Effect.die("must not inspect the vault"),
        }),
        github: stubGitHub({
          findOpenPullRequestNumber: () =>
            Effect.succeed(agentRan ? 321 : null),
        }),
        opencode: stubOpencode({
          continueTurn: (input) => {
            prompt = input.prompt
            agentRan = true
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(321)
      expect(result.completion).toBe("agent_fallback")
      expect(prompt.toLowerCase()).not.toContain("keymaxxer")
      expect(prompt).toContain(
        "Use the gh CLI with the existing ambient authentication",
      )
    }))

  it("uses ambient gh guidance when the backend lacks KeymaxxerMcp even if the vault is enabled", () =>
    withTemp(async (root) => {
      let prompt = ""
      let findSecretCalled = false
      let agentRan = false
      const result = await run(createPr(baseContext(root)), {
        keymaxxer: stubKeymaxxer({
          findSecret: () => {
            findSecretCalled = true
            return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
          },
          // Native push uses vault; agent fallback guidance stays ambient for Grok.
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        }),
        activeBackend: stubGrokActiveAgentBackendLayer,
        github: stubGitHub({
          findOpenPullRequestNumber: () =>
            Effect.succeed(agentRan ? 321 : null),
          createDraftPullRequest: () =>
            Effect.fail(
              new GitHubRequestError({ message: "native create failed" }),
            ),
        }),
        opencode: stubOpencode({
          continueTurn: (input) => {
            prompt = input.prompt
            agentRan = true
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      })

      expect(result.pullRequestNumber).toBe(321)
      // Harness native push still resolves the vault secret.
      expect(findSecretCalled).toBe(true)
      expect(prompt.toLowerCase()).not.toContain("keymaxxer")
      expect(prompt).toContain(
        "Use the gh CLI with the existing ambient authentication",
      )
    }))

  it("maps Keymaxxer credential lookup failure during fallback", () =>
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
        github: stubGitHub({
          findOpenPullRequestNumber: () => Effect.succeed(null),
        }),
      })
      expect(error).toBeInstanceOf(CreatePrCredentialError)
    }))

  it("maps OpenCode failure during fallback", () =>
    withTemp(async (root) => {
      const error = await run(createPr(baseContext(root)).pipe(Effect.flip), {
        github: stubGitHub({
          findOpenPullRequestNumber: () => Effect.succeed(null),
          createDraftPullRequest: () =>
            Effect.fail(
              new GitHubRequestError({ message: "native create failed" }),
            ),
        }),
        opencode: Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () => Effect.die("unused"),
            continueTurn: () =>
              Effect.fail({
                _tag: "AgentBackendExitError",
                exitCode: 2,
                cwd: root,
              } as never),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      })
      expect(error).toBeInstanceOf(CreatePrOpenCodeError)
    }))
})
