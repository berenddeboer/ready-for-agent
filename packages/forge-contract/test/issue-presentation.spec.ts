import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import {
  type ForgeAzureDevOpsPullRequestMutations,
  type ForgeGitHubPullRequestMutations,
  type ForgeGitLabPullRequestMutations,
  type ForgeIssueIdentity,
  type ForgeRepository,
  associateNativePullRequestWithIssue,
  currentNativeForgeClosingReferenceRules,
  resolveForgeIssuePresentation,
  resolveForgePullRequestMutations,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const githubIdentity = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
  issueNumber: 80,
} satisfies ForgeIssueIdentity

const gitlabIdentity = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
  issueNumber: 3601642,
} satisfies ForgeIssueIdentity

const azureIdentity = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
  issueNumber: 4021,
} satisfies ForgeIssueIdentity

const repository: ForgeRepository = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

const githubProvider = (
  actions: string[],
): ForgeGitHubPullRequestMutations<string> => ({
  createDraftPullRequest: () => Effect.succeed(11),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(11),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  closeOpenPullRequestsAndDeleteBranch: () =>
    Effect.sync(() => {
      actions.push("github:cleanup")
    }),
})

const gitlabProvider = (
  actions: string[],
): ForgeGitLabPullRequestMutations<string> => ({
  createDraftPullRequest: () => Effect.succeed(22),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(22),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  closeOpenPullRequestsForBranch: () =>
    Effect.sync(() => {
      actions.push("gitlab:close")
    }),
  deleteBranch: () =>
    Effect.sync(() => {
      actions.push("gitlab:delete")
    }),
})

const azureProvider = (
  actions: string[],
  options: {
    readonly link?: Effect.Effect<void, string>
  } = {},
): ForgeAzureDevOpsPullRequestMutations<string> => ({
  createDraftPullRequest: () => Effect.succeed(33),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(33),
  markPullRequestReadyForReview: () => Effect.void,
  mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
  ensurePullRequestLinkedToIssue: (
    _repository,
    pullRequestNumber,
    issueNumber,
  ) =>
    options.link ??
    Effect.sync(() => {
      actions.push(`azure:link:${pullRequestNumber}:${issueNumber}`)
    }),
  ensureIssueCompletedWithSummary: () =>
    Effect.sync(() => {
      actions.push("azure:complete")
    }),
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
})

const mutationsFor = (forge: Forge, actions: string[]) =>
  resolveForgePullRequestMutations(forge, {
    github: githubProvider(actions),
    gitlab: gitlabProvider(actions),
    azureDevOps: azureProvider(actions),
  })

describe("resolveForgeIssuePresentation", () => {
  it("keeps GitHub identity ambient: no host and no Implement credential line", () => {
    const presentation = resolveForgeIssuePresentation(githubIdentity)

    expect(presentation.identityText).toBe("GitHub issue acme/widgets#80")
    expect(presentation.issueNoun).toBe("GitHub Issue")
    expect(presentation.includeCredentialGuidance).toBe(false)
    expect(presentation.implementAccessScope).toBe("read of the GitHub Issue")
    expect(presentation.nativeCreateAccessScope).toBe(
      "GitHub CLI or API access",
    )
    expect(presentation.stayOpenGuidance).toBe(
      "Leave the tracker Issue open; the harness closes it after merge. Do not close, complete, or change its state, including `gh issue close`.",
    )
    expect(presentation.nativePullRequestAssociation).toEqual({
      kind: "closing_reference",
    })
  })

  it("names the GitLab host and requires credential guidance without closing the Issue", () => {
    const presentation = resolveForgeIssuePresentation(gitlabIdentity)

    expect(presentation.identityText).toBe(
      "GitLab issue project/oauth_client#3601642 on git.drupalcode.org",
    )
    expect(presentation.issueNoun).toBe("GitLab Issue")
    expect(presentation.includeCredentialGuidance).toBe(true)
    expect(presentation.implementAccessScope).toBe("read of the GitLab Issue")
    expect(presentation.nativeCreateAccessScope).toBe(
      "GitLab API or push access",
    )
    expect(presentation.stayOpenGuidance).toBe(
      "Leave the tracker Issue open; the harness closes it after merge. Do not close, complete, or change its state, including `glab issue close` or an API state change.",
    )
    expect(presentation.nativePullRequestAssociation).toEqual({
      kind: "closing_reference",
    })
  })

  it("names the Azure DevOps host and forbids System.State changes while allowing GET", () => {
    const presentation = resolveForgeIssuePresentation(azureIdentity)

    expect(presentation.identityText).toBe(
      "Azure DevOps issue acme/widgets#4021 on dev.azure.com",
    )
    expect(presentation.issueNoun).toBe("Azure DevOps Issue")
    expect(presentation.includeCredentialGuidance).toBe(true)
    expect(presentation.implementAccessScope).toBe(
      "read of the Azure DevOps Issue",
    )
    expect(presentation.nativeCreateAccessScope).toBe(
      "Azure DevOps API or push access",
    )
    expect(presentation.stayOpenGuidance).toBe(
      "Leave the tracker Issue open; the harness closes it after merge. You may GET the Work Item to inspect it. Do not close, complete, or change its state, including PATCH of `System.State`.",
    )
    expect(presentation.nativePullRequestAssociation).toEqual({
      kind: "azure_artifact_link",
    })
  })

  it("uses Closes #N for every current Forge, including Azure", () => {
    for (const identity of [githubIdentity, gitlabIdentity, azureIdentity]) {
      const rules = resolveForgeIssuePresentation(identity).closingReference
      expect(rules.formatLine(identity.issueNumber)).toBe(
        `Closes #${identity.issueNumber}`,
      )
    }
  })
})

describe("currentNativeForgeClosingReferenceRules", () => {
  const rules = currentNativeForgeClosingReferenceRules

  it("strips whole-line close/fix/resolve refs and trailing punctuation for the matching Issue", () => {
    expect(rules.strip("Adds widgets.\n\nCloses #7.", 7)).toBe("Adds widgets.")
    expect(rules.strip("Adds widgets.\n\n- Closes #7", 7)).toBe("Adds widgets.")
    expect(rules.strip("Adds widgets.\n\nFixes #7", 7)).toBe("Adds widgets.")
    expect(rules.strip("Adds widgets.\n\nResolved #7.", 7)).toBe(
      "Adds widgets.",
    )
    expect(rules.strip("Adds widgets.\n\nCloses #8", 7)).toBe(
      "Adds widgets.\n\nCloses #8",
    )
  })

  it("rejects the existing GitHub-worded generic placeholder", () => {
    expect(
      rules.isGenericPlaceholder(
        "Automated draft pull request for GitHub issue #1.",
      ),
    ).toBe(true)
    expect(rules.genericPlaceholderBody(91)).toBe(
      "Automated draft pull request for GitHub issue #91.",
    )
    expect(rules.genericPlaceholderExample).toBe(
      "Automated draft pull request for GitHub issue #N",
    )
  })

  it("keeps existing publication and commit-repair guidance wording", () => {
    expect(rules.mentionGuidance(42)).toBe(
      "You may mention issue #42; the harness will ensure the body ends with exactly one Closes #42 reference.",
    )
    expect(rules.commitMustCloseGuidance(42)).toBe(
      "The commit must still close GitHub issue #42 (include Closes #42 in the body unless policy forbids it — then mention the issue another accepted way).",
    )
  })
})

describe("associateNativePullRequestWithIssue", () => {
  it("does not write an association for GitHub or GitLab", async () => {
    const actions: string[] = []
    await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations: mutationsFor("github", actions),
        repository,
        pullRequestNumber: 11,
        issueNumber: 80,
      }),
    )
    await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations: mutationsFor("gitlab", actions),
        repository,
        pullRequestNumber: 22,
        issueNumber: 3601642,
      }),
    )

    expect(actions).toEqual([])
  })

  it("writes the Azure ArtifactLink with the open PR and Issue identity", async () => {
    const actions: string[] = []
    await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations: mutationsFor("azure-devops", actions),
        repository,
        pullRequestNumber: 91,
        issueNumber: 3601642,
      }),
    )

    expect(actions).toEqual(["azure:link:91:3601642"])
  })

  it("retries the Azure ArtifactLink with the same identity when Create PR reuses a PR", async () => {
    const actions: string[] = []
    const mutations = mutationsFor("azure-devops", actions)

    await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations,
        repository,
        pullRequestNumber: 77,
        issueNumber: 3601642,
      }),
    )
    await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations,
        repository,
        pullRequestNumber: 77,
        issueNumber: 3601642,
      }),
    )

    expect(actions).toEqual(["azure:link:77:3601642", "azure:link:77:3601642"])
  })

  it("surfaces Azure association failure so Create PR can fail the step", async () => {
    const actions: string[] = []
    const error = await Effect.runPromise(
      associateNativePullRequestWithIssue({
        mutations: resolveForgePullRequestMutations("azure-devops", {
          github: githubProvider(actions),
          gitlab: gitlabProvider(actions),
          azureDevOps: azureProvider(actions, {
            link: Effect.sync(() => {
              actions.push("azure:link")
            }).pipe(Effect.flatMap(() => Effect.fail("link failed"))),
          }),
        }),
        repository,
        pullRequestNumber: 33,
        issueNumber: 7,
      }).pipe(Effect.flip),
    )

    expect(error).toBe("link failed")
    expect(actions).toEqual(["azure:link"])
  })
})
