import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import {
  type ForgeIssueOperations,
  type ForgeRepository,
  type ReadyLabeledIssue,
  resolveForgeIssueOperations,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository: ForgeRepository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

const issue = (number: number): ReadyLabeledIssue => ({
  number,
  title: `Issue ${number}`,
  body: "",
  url: `https://github.com/acme/widgets/issues/${number}`,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  state: "OPEN",
  author: "operator",
  parent: null,
  parentPosition: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
  closingPullRequests: [],
})

const recordingProvider = (
  label: string,
  actions: string[],
  issues: readonly ReadyLabeledIssue[] = [issue(1)],
): ForgeIssueOperations<string> => ({
  getAuthenticatedUserLogin: () =>
    Effect.sync(() => {
      actions.push(`${label}:identity`)
      return "operator"
    }),
  listReadyIssues: () =>
    Effect.sync(() => {
      actions.push(`${label}:list`)
      return issues
    }),
  ensureIssueCompletedWithSummary: (
    _repository,
    issueNumber,
    workItemId,
    summaryMarkdown,
  ) =>
    Effect.sync(() => {
      actions.push(
        `${label}:complete:${issueNumber}:${workItemId}:${summaryMarkdown}`,
      )
    }),
})

const githubRecordingProvider = (
  actions: string[],
  issues: readonly ReadyLabeledIssue[] = [issue(1)],
) => ({
  getAuthenticatedUserLogin: (
    _repository: ForgeRepository,
    options?: { readonly origin: string },
  ) =>
    Effect.sync(() => {
      actions.push(`github:identity:${options?.origin ?? "none"}`)
      return "operator"
    }),
  listReadyIssues: (
    _repository: ForgeRepository,
    options?: { readonly origin: string },
  ) =>
    Effect.sync(() => {
      actions.push(`github:list:${options?.origin ?? "none"}`)
      return issues
    }),
  ensureIssueCompletedWithSummary: (
    _repository: ForgeRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) =>
    Effect.sync(() => {
      actions.push(
        `github:complete:${issueNumber}:${workItemId}:${summaryMarkdown}`,
      )
    }),
})

const providersFor = (actions: string[]) => ({
  github: githubRecordingProvider(actions),
  gitlab: recordingProvider("gitlab", actions),
  azureDevOps: recordingProvider("azure", actions),
})

const fetch = (
  forge: Forge,
  actions: string[],
  includeAllIssueAuthors: boolean,
  githubOperation?: { readonly origin: string },
) =>
  resolveForgeIssueOperations(
    forge,
    providersFor(actions),
    githubOperation,
  ).listReadyIssuesWithAuthorScope(repository, includeAllIssueAuthors)

describe("resolveForgeIssueOperations", () => {
  it("lists GitHub Ready Issues before resolving identity so author scope uses the refreshed credential", async () => {
    const actions: string[] = []
    const result = await Effect.runPromise(fetch("github", actions, false))

    expect(actions).toEqual(["github:list:none", "github:identity:none"])
    expect(result.authorScope).toEqual({
      includeAll: false,
      operatorLogin: "operator",
    })
    expect(result.remoteIssues).toEqual([issue(1)])
  })

  it("forwards GitHub operation origin to listing and identity", async () => {
    const actions: string[] = []
    await Effect.runPromise(
      fetch("github", actions, false, { origin: "polling" }),
    )

    expect(actions).toEqual(["github:list:polling", "github:identity:polling"])
  })

  it("resolves GitLab identity before listing Ready Issues", async () => {
    const actions: string[] = []
    await Effect.runPromise(fetch("gitlab", actions, false))

    expect(actions).toEqual(["gitlab:identity", "gitlab:list"])
  })

  it("resolves Azure DevOps identity before listing Ready Issues", async () => {
    const actions: string[] = []
    await Effect.runPromise(fetch("azure-devops", actions, false))

    expect(actions).toEqual(["azure:identity", "azure:list"])
  })

  it("skips authenticated-user lookup when Include all Issue Authors is on", async () => {
    for (const forge of ["github", "gitlab", "azure-devops"] as const) {
      const actions: string[] = []
      const result = await Effect.runPromise(fetch(forge, actions, true))
      expect(result.authorScope).toEqual({ includeAll: true })
      expect(actions.some((action) => action.includes("identity"))).toBe(false)
      expect(actions.some((action) => action.includes("list"))).toBe(true)
    }
  })

  it("completes the Issue through the selected Forge only", async () => {
    const actions: string[] = []
    const providers = providersFor(actions)

    await Effect.runPromise(
      resolveForgeIssueOperations(
        "gitlab",
        providers,
      ).ensureIssueCompletedWithSummary(repository, 42, "wi-1", "Done."),
    )
    await Effect.runPromise(
      resolveForgeIssueOperations(
        "azure-devops",
        providers,
      ).ensureIssueCompletedWithSummary(repository, 7, "wi-2", "Closed."),
    )
    await Effect.runPromise(
      resolveForgeIssueOperations(
        "github",
        providers,
      ).ensureIssueCompletedWithSummary(repository, 9, "wi-3", "Summary."),
    )

    expect(actions).toEqual([
      "gitlab:complete:42:wi-1:Done.",
      "azure:complete:7:wi-2:Closed.",
      "github:complete:9:wi-3:Summary.",
    ])
  })

  it("does not list GitLab Issues when identity fails", async () => {
    const actions: string[] = []
    const error = "identity failed"
    const result = await Effect.runPromise(
      resolveForgeIssueOperations("gitlab", {
        github: githubRecordingProvider(actions),
        gitlab: {
          getAuthenticatedUserLogin: () =>
            Effect.sync(() => {
              actions.push("gitlab:identity")
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          listReadyIssues: () =>
            Effect.sync(() => {
              actions.push("gitlab:list")
              return []
            }),
          ensureIssueCompletedWithSummary: () => Effect.void,
        },
        azureDevOps: recordingProvider("azure", actions),
      })
        .listReadyIssuesWithAuthorScope(repository, false)
        .pipe(Effect.flip),
    )

    expect(result).toBe(error)
    expect(actions).toEqual(["gitlab:identity"])
  })
})
