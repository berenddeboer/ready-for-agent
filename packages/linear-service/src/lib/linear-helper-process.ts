import type { Effect } from "effect"
import { runLinearCli } from "../bin/cli.js"
import { ensureMilestoneCommentProgram } from "../bin/ensure-milestone-comment.js"
import { getAuthenticatedUserLoginProgram } from "../bin/get-authenticated-user-login.js"
import { getIssueProgram } from "../bin/get-issue.js"
import { listProjectWorkflowProgram } from "../bin/list-project-workflow.js"
import { listProjectsProgram } from "../bin/list-projects.js"
import { listReadyIssuesProgram } from "../bin/list-ready-issues.js"
import { updateIssueStateProgram } from "../bin/update-issue-state.js"
import { linearServiceBinScriptPath } from "../bin-script-path.js"
import type { LinearService } from "./linear-service.js"

/** Hidden argv token: re-enter the same executable as a Linear helper. */
export const INTERNAL_LINEAR_HELPER_ARG =
  "--ready-for-agent-internal-linear-helper"

export const LINEAR_HELPER_OPERATIONS = [
  "get-authenticated-user-login",
  "list-ready-issues",
  "list-projects",
  "list-project-workflow",
  "get-issue",
  "update-issue-state",
  "ensure-milestone-comment",
] as const

export type LinearHelperOperation = (typeof LINEAR_HELPER_OPERATIONS)[number]

export const isLinearHelperOperation = (
  value: string,
): value is LinearHelperOperation =>
  (LINEAR_HELPER_OPERATIONS as ReadonlyArray<string>).includes(value)

export const isInternalLinearHelperMode = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes(INTERNAL_LINEAR_HELPER_ARG)

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

export type LinearHelperChildSpawn = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export const resolveLinearHelperChildSpawn = (input: {
  readonly operation: LinearHelperOperation
  readonly args: ReadonlyArray<string>
  readonly execPath?: string
  readonly argv?: ReadonlyArray<string>
  readonly sourceConditions?: ReadonlyArray<string>
}): LinearHelperChildSpawn => {
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv

  if (isStandaloneExecutable(execPath, argv)) {
    return {
      command: execPath,
      args: [INTERNAL_LINEAR_HELPER_ARG, input.operation, ...input.args],
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
      linearServiceBinScriptPath(`${input.operation}.ts`),
      ...input.args,
    ],
  }
}

export const formatLinearHelperShellCommand = (
  spawn: LinearHelperChildSpawn,
): string =>
  [spawn.command, ...spawn.args].map((part) => JSON.stringify(part)).join(" ")

const programs: Record<
  LinearHelperOperation,
  (args: ReadonlyArray<string>) => Effect.Effect<void, unknown, LinearService>
> = {
  "get-authenticated-user-login": getAuthenticatedUserLoginProgram,
  "list-ready-issues": listReadyIssuesProgram,
  "list-projects": listProjectsProgram,
  "list-project-workflow": listProjectWorkflowProgram,
  "get-issue": getIssueProgram,
  "update-issue-state": updateIssueStateProgram,
  "ensure-milestone-comment": ensureMilestoneCommentProgram,
}

export const runLinearHelperProcess = (
  argv: ReadonlyArray<string> = process.argv,
): void => {
  const flagIndex = argv.indexOf(INTERNAL_LINEAR_HELPER_ARG)
  if (flagIndex < 0) {
    process.stderr.write("Missing internal Linear helper mode flag\n")
    process.exitCode = 1
    return
  }
  const operation = argv[flagIndex + 1]
  if (operation === undefined || !isLinearHelperOperation(operation)) {
    process.stderr.write(
      `Unknown Linear helper operation: ${operation ?? "(missing)"}\n`,
    )
    process.exitCode = 1
    return
  }
  const args = argv.slice(flagIndex + 2)
  runLinearCli(programs[operation](args))
}
