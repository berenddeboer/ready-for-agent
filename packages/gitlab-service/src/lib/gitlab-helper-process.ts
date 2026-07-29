import type { Effect } from "effect"
import { runGitLabCli } from "../bin/cli.js"
import { closeOpenPullRequestsForBranchProgram } from "../bin/close-open-pull-requests-for-branch.js"
import { countOpenNonDraftPullRequestsProgram } from "../bin/count-open-non-draft-pull-requests.js"
import { createDraftPullRequestProgram } from "../bin/create-draft-pull-request.js"
import { deleteBranchProgram } from "../bin/delete-branch.js"
import { ensureIssueCompletedWithSummaryProgram } from "../bin/ensure-issue-completed-with-summary.js"
import { findOpenPullRequestNumberProgram } from "../bin/find-open-pull-request-number.js"
import { getAuthenticatedUserLoginProgram } from "../bin/get-authenticated-user-login.js"
import { getOpenPullRequestNumberProgram } from "../bin/get-open-pull-request-number.js"
import { getPrCheckStatusProgram } from "../bin/get-pr-check-status.js"
import { getPrLifecycleStatusProgram } from "../bin/get-pr-lifecycle-status.js"
import { getPrStatusCheckDiagnosticsProgram } from "../bin/get-pr-status-check-diagnostics.js"
import { listReadyIssuesProgram } from "../bin/list-ready-issues.js"
import { markPrReadyForReviewProgram } from "../bin/mark-pr-ready-for-review.js"
import { mergePullRequestProgram } from "../bin/merge-pull-request.js"
import { updateOpenDraftPullRequestCopyProgram } from "../bin/update-open-draft-pull-request-copy.js"
import { verifyProjectProgram } from "../bin/verify-project.js"
import { gitlabServiceBinScriptPath } from "../bin-script-path.js"
import type { GitLabService } from "./gitlab-service.js"

/** Hidden argv token: re-enter the same executable as a GitLab helper. */
export const INTERNAL_GITLAB_HELPER_ARG =
  "--ready-for-agent-internal-gitlab-helper"

export const GITLAB_HELPER_OPERATIONS = [
  "list-ready-issues",
  "get-authenticated-user-login",
  "verify-project",
  "get-open-pull-request-number",
  "find-open-pull-request-number",
  "create-draft-pull-request",
  "update-open-draft-pull-request-copy",
  "count-open-non-draft-pull-requests",
  "get-pr-check-status",
  "get-pr-status-check-diagnostics",
  "mark-pr-ready-for-review",
  "get-pr-lifecycle-status",
  "merge-pull-request",
  "ensure-issue-completed-with-summary",
  "close-open-pull-requests-for-branch",
  "delete-branch",
] as const

export type GitLabHelperOperation = (typeof GITLAB_HELPER_OPERATIONS)[number]

export const isGitLabHelperOperation = (
  value: string,
): value is GitLabHelperOperation =>
  (GITLAB_HELPER_OPERATIONS as ReadonlyArray<string>).includes(value)

export const isInternalGitLabHelperMode = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes(INTERNAL_GITLAB_HELPER_ARG)

/**
 * True when this process is a compiled standalone product binary rather than
 * `bun path/to/script.ts` (or similar source execution).
 */
export const isStandaloneExecutable = (
  execPath: string = process.execPath,
  argv: ReadonlyArray<string> = process.argv,
): boolean => {
  const base = execPath.split(/[/\\]/).pop() ?? ""
  if (
    base === "bun" ||
    base === "bun.exe" ||
    base === "node" ||
    base === "node.exe"
  ) {
    return false
  }
  const maybeScript = argv[1]
  if (
    maybeScript !== undefined &&
    /\.(m?[jt]sx?|cjs|mts|cts)$/i.test(maybeScript)
  ) {
    return false
  }
  return true
}

export type GitLabHelperChildSpawn = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * How Keymaxxer should spawn a GitLab helper child.
 * Compiled binaries: `execPath --ready-for-agent-internal-gitlab-helper <op> …`.
 * Source: same Bun runtime + workspace bin script + encoded args.
 */
export const resolveGitLabHelperChildSpawn = (input: {
  readonly operation: GitLabHelperOperation
  readonly args: ReadonlyArray<string>
  readonly execPath?: string
  readonly argv?: ReadonlyArray<string>
  readonly sourceConditions?: ReadonlyArray<string>
}): GitLabHelperChildSpawn => {
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv

  if (isStandaloneExecutable(execPath, argv)) {
    return {
      command: execPath,
      args: [INTERNAL_GITLAB_HELPER_ARG, input.operation, ...input.args],
    }
  }

  const conditions = input.sourceConditions ?? [
    "--conditions",
    "@ready-for-agent/source",
  ]

  return {
    command: execPath,
    args: [
      ...conditions,
      gitlabServiceBinScriptPath(`${input.operation}.ts`),
      ...input.args,
    ],
  }
}

/** Shell-safe command string for Keymaxxer `runWithSecrets`. */
export const formatGitLabHelperShellCommand = (
  spawn: GitLabHelperChildSpawn,
): string =>
  [spawn.command, ...spawn.args].map((part) => JSON.stringify(part)).join(" ")

const programs: Record<
  GitLabHelperOperation,
  (args: ReadonlyArray<string>) => Effect.Effect<void, unknown, GitLabService>
> = {
  "list-ready-issues": listReadyIssuesProgram,
  "get-authenticated-user-login": getAuthenticatedUserLoginProgram,
  "verify-project": verifyProjectProgram,
  "get-open-pull-request-number": getOpenPullRequestNumberProgram,
  "find-open-pull-request-number": findOpenPullRequestNumberProgram,
  "create-draft-pull-request": createDraftPullRequestProgram,
  "update-open-draft-pull-request-copy": updateOpenDraftPullRequestCopyProgram,
  "count-open-non-draft-pull-requests": countOpenNonDraftPullRequestsProgram,
  "get-pr-check-status": getPrCheckStatusProgram,
  "get-pr-status-check-diagnostics": getPrStatusCheckDiagnosticsProgram,
  "mark-pr-ready-for-review": markPrReadyForReviewProgram,
  "get-pr-lifecycle-status": getPrLifecycleStatusProgram,
  "merge-pull-request": mergePullRequestProgram,
  "ensure-issue-completed-with-summary": ensureIssueCompletedWithSummaryProgram,
  "close-open-pull-requests-for-branch": closeOpenPullRequestsForBranchProgram,
  "delete-branch": deleteBranchProgram,
}

/**
 * Product-binary / harness entry body for internal GitLab helper mode.
 * Operation name is the argv token after {@link INTERNAL_GITLAB_HELPER_ARG};
 * remaining tokens are base64url-encoded helper arguments.
 */
export const runGitLabHelperProcess = (
  argv: ReadonlyArray<string> = process.argv,
): void => {
  const flagIndex = argv.indexOf(INTERNAL_GITLAB_HELPER_ARG)
  if (flagIndex < 0) {
    process.stderr.write("Missing internal GitLab helper mode flag\n")
    process.exitCode = 1
    return
  }
  const operation = argv[flagIndex + 1]
  if (operation === undefined || !isGitLabHelperOperation(operation)) {
    process.stderr.write(
      `Unknown GitLab helper operation: ${operation ?? "(missing)"}\n`,
    )
    process.exitCode = 1
    return
  }
  const args = argv.slice(flagIndex + 2)
  runGitLabCli(programs[operation](args))
}
