import type { Effect } from "effect"
import { runAzureDevOpsCli } from "../bin/cli.js"
import { getAuthenticatedUserLoginProgram } from "../bin/get-authenticated-user-login.js"
import { verifyProjectProgram } from "../bin/verify-project.js"
import { azureDevOpsServiceBinScriptPath } from "../bin-script-path.js"
import type { AzureDevOpsService } from "./azure-devops-service.js"

/** Hidden argv token: re-enter the same executable as an Azure DevOps helper. */
export const INTERNAL_AZURE_DEVOPS_HELPER_ARG =
  "--ready-for-agent-internal-azure-devops-helper"

/**
 * CLI-backed operations. `hasCredentials`/`hasAmbientCredentials` are
 * synchronous local checks (no vault secret needed) and never need a
 * subprocess, matching GitLab's helper operation set. Of the 19-method
 * surface that leaves 15 future helper candidates: 14 are already
 * implemented against the live REST API in-process, while
 * `countOpenNonDraftPullRequests` still fails with
 * `AzureDevOpsNotImplementedError`. Each gains a helper operation (and
 * Keymaxxer child-spawn wiring) in later tickets.
 */
export const AZURE_DEVOPS_HELPER_OPERATIONS = [
  "verify-project",
  "get-authenticated-user-login",
] as const

export type AzureDevOpsHelperOperation =
  (typeof AZURE_DEVOPS_HELPER_OPERATIONS)[number]

export const isAzureDevOpsHelperOperation = (
  value: string,
): value is AzureDevOpsHelperOperation =>
  (AZURE_DEVOPS_HELPER_OPERATIONS as ReadonlyArray<string>).includes(value)

export const isInternalAzureDevOpsHelperMode = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes(INTERNAL_AZURE_DEVOPS_HELPER_ARG)

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

export type AzureDevOpsHelperChildSpawn = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * How Keymaxxer should spawn an Azure DevOps helper child.
 * Compiled binaries: `execPath --ready-for-agent-internal-azure-devops-helper <op> …`.
 * Source: same Bun runtime + workspace bin script + encoded args.
 */
export const resolveAzureDevOpsHelperChildSpawn = (input: {
  readonly operation: AzureDevOpsHelperOperation
  readonly args: ReadonlyArray<string>
  readonly execPath?: string
  readonly argv?: ReadonlyArray<string>
  readonly sourceConditions?: ReadonlyArray<string>
}): AzureDevOpsHelperChildSpawn => {
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv

  if (isStandaloneExecutable(execPath, argv)) {
    return {
      command: execPath,
      args: [INTERNAL_AZURE_DEVOPS_HELPER_ARG, input.operation, ...input.args],
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
      azureDevOpsServiceBinScriptPath(`${input.operation}.ts`),
      ...input.args,
    ],
  }
}

/** Shell-safe command string for Keymaxxer `runWithSecrets`. */
export const formatAzureDevOpsHelperShellCommand = (
  spawn: AzureDevOpsHelperChildSpawn,
): string =>
  [spawn.command, ...spawn.args].map((part) => JSON.stringify(part)).join(" ")

const programs: Record<
  AzureDevOpsHelperOperation,
  (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, unknown, AzureDevOpsService>
> = {
  "verify-project": verifyProjectProgram,
  "get-authenticated-user-login": getAuthenticatedUserLoginProgram,
}

/**
 * Product-binary / harness entry body for internal Azure DevOps helper mode.
 * Operation name is the argv token after
 * {@link INTERNAL_AZURE_DEVOPS_HELPER_ARG}; remaining tokens are
 * base64url-encoded helper arguments.
 */
export const runAzureDevOpsHelperProcess = (
  argv: ReadonlyArray<string> = process.argv,
): void => {
  const flagIndex = argv.indexOf(INTERNAL_AZURE_DEVOPS_HELPER_ARG)
  if (flagIndex < 0) {
    process.stderr.write("Missing internal Azure DevOps helper mode flag\n")
    process.exitCode = 1
    return
  }
  const operation = argv[flagIndex + 1]
  if (operation === undefined || !isAzureDevOpsHelperOperation(operation)) {
    process.stderr.write(
      `Unknown Azure DevOps helper operation: ${operation ?? "(missing)"}\n`,
    )
    process.exitCode = 1
    return
  }
  const args = argv.slice(flagIndex + 2)
  runAzureDevOpsCli(programs[operation](args))
}
