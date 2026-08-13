import {
  type RelevantIssuePredicateContext,
  type RelevantIssuePredicateShape,
  type WorkItemPredicateShape,
  evaluateActionableIssue,
  evaluateImplementableIssue,
  evaluateLeafIssue,
  evaluateRelevantIssue,
  evaluateUnfinishedWorkItem,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const openLeaf = {
  isCurrentIssue: true,
  state: "OPEN",
  hasChildren: false,
  blockedBy: [],
} as const

const relevantIssue = (
  overrides: Partial<RelevantIssuePredicateShape> = {},
): RelevantIssuePredicateShape => ({
  state: "OPEN",
  author: "operator",
  parent: null,
  hasChildren: false,
  hierarchySupported: true,
  closingPullRequests: [],
  ...overrides,
})

const relevantContext = (
  overrides: Partial<RelevantIssuePredicateContext> = {},
): RelevantIssuePredicateContext => ({
  forge: "github",
  repositoryName: "owner/repository",
  workItemPullRequestNumbers: new Set(),
  authorScope: { includeAll: false, operatorLogin: "operator" },
  ...overrides,
})

describe("shared lifecycle predicates", () => {
  it("defines Leaf Issue with missing and not-leaf failures", () => {
    expect(evaluateLeafIssue(undefined)).toEqual({ _tag: "issue_missing" })
    expect(evaluateLeafIssue({ hasChildren: true })).toEqual({
      _tag: "issue_not_leaf",
    })
    expect(evaluateLeafIssue(openLeaf)).toEqual({ _tag: "match" })
  })

  it("defines Implementable Issue with closed and blocked failures", () => {
    expect(
      evaluateImplementableIssue({ ...openLeaf, isCurrentIssue: false }),
    ).toEqual({ _tag: "issue_missing" })
    expect(
      evaluateImplementableIssue({ ...openLeaf, state: "CLOSED" }),
    ).toEqual({
      _tag: "issue_not_open",
      state: "CLOSED",
    })
    expect(
      evaluateImplementableIssue({ ...openLeaf, blockedBy: [{ number: 7 }] }),
    ).toEqual({
      _tag: "issue_blocked",
      blockerCount: 1,
    })
    expect(evaluateImplementableIssue(openLeaf)).toEqual({ _tag: "match" })
  })

  it("defines Actionable Issue with an unfinished Work Item failure", () => {
    expect(
      evaluateActionableIssue(openLeaf, [
        { id: "wi-current", state: "implement", canRetry: false },
      ]),
    ).toEqual({
      _tag: "unfinished_work_item_exists",
      workItemId: "wi-current",
    })
    expect(
      evaluateActionableIssue(openLeaf, [
        { id: "wi-complete", state: "complete", canRetry: false },
      ]),
    ).toEqual({ _tag: "match" })
    expect(
      evaluateActionableIssue(openLeaf, [
        { id: "wi-retryable", state: "failed", canRetry: true },
      ]),
    ).toEqual({
      _tag: "unfinished_work_item_exists",
      workItemId: "wi-retryable",
    })
  })

  it("defines unfinished Work Item and counts Needs Human as unfinished", () => {
    const unfinishedStates: readonly WorkItemPredicateShape["state"][] = [
      "create_worktree",
      "needs_human",
    ]
    for (const state of unfinishedStates) {
      expect(evaluateUnfinishedWorkItem({ state, canRetry: false })).toEqual({
        _tag: "match",
      })
    }

    for (const state of ["complete", "failed", "abandoned"] as const) {
      expect(evaluateUnfinishedWorkItem({ state, canRetry: false })).toEqual({
        _tag: "work_item_finished",
        state,
      })
    }

    expect(
      evaluateUnfinishedWorkItem({ state: "failed", canRetry: true }),
    ).toEqual({ _tag: "match" })
  })

  it("defines Relevant Issue hierarchy failures", () => {
    expect(evaluateRelevantIssue(undefined, relevantContext())).toEqual({
      _tag: "issue_missing",
    })
    expect(
      evaluateRelevantIssue(
        relevantIssue({ hierarchySupported: false }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_hierarchy_unsupported" })
    expect(
      evaluateRelevantIssue(
        relevantIssue({
          parent: { state: "CLOSED", isReadyLabeled: true },
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_parent_not_open", state: "CLOSED" })
    expect(
      evaluateRelevantIssue(
        relevantIssue({
          parent: { state: "OPEN", isReadyLabeled: false },
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_parent_not_ready" })
  })

  it("defines Relevant Issue closing-PR and author failures", () => {
    expect(
      evaluateRelevantIssue(
        relevantIssue({
          closingPullRequests: [
            {
              number: 9,
              repository: "owner/repository",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          closingPullRequests: [
            {
              number: 9,
              repository: "owner/repository",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        relevantContext({
          repositoryName: "OWNER/REPOSITORY",
          workItemPullRequestNumbers: new Set([9]),
        }),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({ author: "someone-else" }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_author_not_in_scope" })
  })

  it("treats a merged Issue-closing PR as historical after the Issue is reopened", () => {
    const mergedClosingPullRequest = {
      number: 9,
      repository: "owner/repository",
      state: "MERGED",
      isDraft: false,
    } as const
    const openClosingPullRequest = {
      number: 10,
      repository: "owner/repository",
      state: "OPEN",
      isDraft: false,
    } as const

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          closingPullRequests: [mergedClosingPullRequest],
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "match" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          closingPullRequests: [openClosingPullRequest],
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          closingPullRequests: [
            openClosingPullRequest,
            mergedClosingPullRequest,
          ],
        }),
        relevantContext({ workItemPullRequestNumbers: new Set([9]) }),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          state: "CLOSED",
          parent: { state: "OPEN", isReadyLabeled: true },
          closingPullRequests: [mergedClosingPullRequest],
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          state: "CLOSED",
          closingPullRequests: [mergedClosingPullRequest],
        }),
        relevantContext(),
      ),
    ).toEqual({ _tag: "issue_not_open", state: "CLOSED" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          hierarchySupported: false,
          closingPullRequests: [mergedClosingPullRequest],
        }),
        relevantContext({
          forge: "gitlab",
          authorScope: { includeAll: true },
        }),
      ),
    ).toEqual({ _tag: "match" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          hierarchySupported: false,
          closingPullRequests: [openClosingPullRequest],
        }),
        relevantContext({
          forge: "gitlab",
          authorScope: { includeAll: true },
        }),
      ),
    ).toEqual({ _tag: "issue_closing_pull_request_unowned" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({
          hierarchySupported: false,
          state: "CLOSED",
          closingPullRequests: [mergedClosingPullRequest],
        }),
        relevantContext({
          forge: "gitlab",
          authorScope: { includeAll: true },
        }),
      ),
    ).toEqual({ _tag: "issue_not_open", state: "CLOSED" })
  })

  it("matches Relevant closed children, owned PRs, and GitLab roots", () => {
    expect(
      evaluateRelevantIssue(
        relevantIssue({
          state: "CLOSED",
          parent: { state: "OPEN", isReadyLabeled: true },
          closingPullRequests: [
            {
              number: 9,
              repository: "OWNER/REPOSITORY",
              state: "MERGED",
              isDraft: false,
            },
          ],
        }),
        relevantContext({ workItemPullRequestNumbers: new Set([9]) }),
      ),
    ).toEqual({ _tag: "match" })

    expect(
      evaluateRelevantIssue(
        relevantIssue({ hierarchySupported: false }),
        relevantContext({
          forge: "gitlab",
          authorScope: { includeAll: true },
        }),
      ),
    ).toEqual({ _tag: "match" })
  })
})
