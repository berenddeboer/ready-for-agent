import type { Effect } from "effect"
import { runGitHubCli } from "../bin/cli.js"
import { ensureIssueCompletedWithSummaryProgram } from "../bin/ensure-issue-completed-with-summary.js"
import { getAuthenticatedUserLoginProgram } from "../bin/get-authenticated-user-login.js"
import { getOpenPullRequestNumberProgram } from "../bin/get-open-pr-number.js"
import { getPrCheckStatusProgram } from "../bin/get-pr-check-status.js"
import { getPrLifecycleStatusProgram } from "../bin/get-pr-lifecycle-status.js"
import { getPrStatusCheckDiagnosticsProgram } from "../bin/get-pr-status-check-diagnostics.js"
import { listReadyIssuesProgram } from "../bin/list-ready-issues.js"
import { markPrReadyForReviewProgram } from "../bin/mark-pr-ready-for-review.js"
import { mergePullRequestProgram } from "../bin/merge-pull-request.js"
import { rerunWorkflowRunProgram } from "../bin/rerun-workflow-run.js"
import { githubServiceBinScriptPath } from "../bin-script-path.js"
import type { GitHubService } from "./github-service.js"

/** Hidden argv token: re-enter the same executable as a GitHub helper. */
export const INTERNAL_GITHUB_HELPER_ARG =
  "--ready-for-agent-internal-github-helper"

export const GITHUB_HELPER_OPERATIONS = [
  "list-ready-issues",
  "get-authenticated-user-login",
  "get-open-pr-number",
  "get-pr-check-status",
  "get-pr-status-check-diagnostics",
  "get-pr-lifecycle-status",
  "mark-pr-ready-for-review",
  "merge-pull-request",
  "rerun-workflow-run",
  "ensure-issue-completed-with-summary",
] as const

export type GitHubHelperOperation = (typeof GITHUB_HELPER_OPERATIONS)[number]

export const isGitHubHelperOperation = (
  value: string,
): value is GitHubHelperOperation =>
  (GITHUB_HELPER_OPERATIONS as ReadonlyArray<string>).includes(value)

export const isInternalGitHubHelperMode = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes(INTERNAL_GITHUB_HELPER_ARG)

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

export type GitHubHelperChildSpawn = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * How Keymaxxer should spawn a GitHub helper child.
 * Compiled binaries: `execPath --ready-for-agent-internal-github-helper <op> …`.
 * Source: same Bun runtime + workspace bin script + encoded args.
 */
export const resolveGitHubHelperChildSpawn = (input: {
  readonly operation: GitHubHelperOperation
  readonly args: ReadonlyArray<string>
  readonly execPath?: string
  readonly argv?: ReadonlyArray<string>
  readonly sourceConditions?: ReadonlyArray<string>
}): GitHubHelperChildSpawn => {
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv

  if (isStandaloneExecutable(execPath, argv)) {
    return {
      command: execPath,
      args: [INTERNAL_GITHUB_HELPER_ARG, input.operation, ...input.args],
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
      githubServiceBinScriptPath(`${input.operation}.ts`),
      ...input.args,
    ],
  }
}

/** Shell-safe command string for Keymaxxer `runWithSecrets`. */
export const formatGitHubHelperShellCommand = (
  spawn: GitHubHelperChildSpawn,
): string =>
  [spawn.command, ...spawn.args].map((part) => JSON.stringify(part)).join(" ")

const programs: Record<
  GitHubHelperOperation,
  (args: ReadonlyArray<string>) => Effect.Effect<void, unknown, GitHubService>
> = {
  "list-ready-issues": listReadyIssuesProgram,
  "get-authenticated-user-login": getAuthenticatedUserLoginProgram,
  "get-open-pr-number": getOpenPullRequestNumberProgram,
  "get-pr-check-status": getPrCheckStatusProgram,
  "get-pr-status-check-diagnostics": getPrStatusCheckDiagnosticsProgram,
  "get-pr-lifecycle-status": getPrLifecycleStatusProgram,
  "mark-pr-ready-for-review": markPrReadyForReviewProgram,
  "merge-pull-request": mergePullRequestProgram,
  "rerun-workflow-run": rerunWorkflowRunProgram,
  "ensure-issue-completed-with-summary": ensureIssueCompletedWithSummaryProgram,
}

/**
 * Product-binary / harness entry body for internal GitHub helper mode.
 * Operation name is the argv token after {@link INTERNAL_GITHUB_HELPER_ARG};
 * remaining tokens are base64url-encoded helper arguments.
 */
export const runGitHubHelperProcess = (
  argv: ReadonlyArray<string> = process.argv,
): void => {
  const flagIndex = argv.indexOf(INTERNAL_GITHUB_HELPER_ARG)
  if (flagIndex < 0) {
    process.stderr.write("Missing internal GitHub helper mode flag\n")
    process.exitCode = 1
    return
  }
  const operation = argv[flagIndex + 1]
  if (operation === undefined || !isGitHubHelperOperation(operation)) {
    process.stderr.write(
      `Unknown GitHub helper operation: ${operation ?? "(missing)"}\n`,
    )
    process.exitCode = 1
    return
  }
  const args = argv.slice(flagIndex + 2)
  runGitHubCli(programs[operation](args))
}
