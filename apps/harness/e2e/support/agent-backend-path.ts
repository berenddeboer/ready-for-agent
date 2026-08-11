/**
 * Product PATH control for live e2e Agent Backend modes (issue #958).
 *
 * `no-opencode` must fail closed if ambient developer/CI coder CLIs would
 * otherwise leak onto the Harness process PATH and silently green pure-absence
 * scenarios. Fake `claude` is prepended separately; ambient `claude` dirs are
 * stripped so only the controlled fake remains.
 */

import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"

export type AgentBackendE2eMode = "default" | "no-opencode"

const MODE_ENV = "E2E_AGENT_BACKEND_MODE"

/**
 * Ambient Agent Backend CLIs stripped under `no-opencode` so pure-absence and
 * mixed-Ready scenarios only see the fake `claude` the supervisor installs.
 * Default harness backend `opencode` is included; other first-party binaries
 * must not report Ready from a developer PATH.
 */
export const NO_OPENCODE_STRIPPED_BINARIES = [
  "opencode",
  "grok",
  "codex",
  "claude",
] as const

/**
 * Resolves the live e2e Agent Backend PATH mode. Unknown values fail closed
 * rather than silently running as `default`.
 */
export const resolveAgentBackendE2eMode = (
  environment: NodeJS.ProcessEnv = process.env,
): AgentBackendE2eMode => {
  const raw = environment[MODE_ENV]?.trim().toLowerCase()
  if (raw === undefined || raw === "" || raw === "default") {
    return "default"
  }
  if (raw === "no-opencode") {
    return "no-opencode"
  }
  throw new Error(
    `${MODE_ENV} must be "default" or "no-opencode", got ${JSON.stringify(environment[MODE_ENV])}`,
  )
}

const isExecutableFile = (path: string): boolean => {
  if (!existsSync(path)) {
    return false
  }
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // Present but not executable still counts as providing the name for PATH
    // pollution purposes (e.g. a non-exec stub that would confuse which).
    return existsSync(path)
  }
}

/** True when `dir` contains a file named `binary` (optionally executable). */
export const directoryProvidesBinary = (
  dir: string,
  binary: string,
): boolean => {
  if (dir.length === 0) {
    return false
  }
  return isExecutableFile(join(dir, binary))
}

/**
 * Drop every PATH entry that provides any of `binaries` so ambient installs
 * cannot shadow the product PATH under test.
 */
export const pathWithoutBinaries = (
  pathEnv: string,
  binaries: readonly string[],
): string =>
  pathEnv
    .split(delimiter)
    .filter(
      (dir) =>
        dir.length > 0 &&
        !binaries.some((binary) => directoryProvidesBinary(dir, binary)),
    )
    .join(delimiter)

export type ResolveWhich = (
  command: string,
  options?: { PATH?: string },
) => string | null

/**
 * Fail closed when ambient coder CLIs remain resolvable on the product PATH
 * under `no-opencode` mode (except the fake `claude` we just prepended).
 * Returns without throwing in `default` mode.
 */
export const assertNoAmbientAgentCliOnProductPath = (options: {
  readonly mode: AgentBackendE2eMode
  readonly productPath: string
  readonly fakeCliBinDir: string
  readonly which?: ResolveWhich
}): void => {
  if (options.mode !== "no-opencode") {
    return
  }
  const which = options.which ?? ((command, opts) => Bun.which(command, opts))
  for (const binary of NO_OPENCODE_STRIPPED_BINARIES) {
    const found = which(binary, { PATH: options.productPath })
    if (found === null) {
      if (binary === "claude") {
        throw new Error(
          `${MODE_ENV}=no-opencode requires the fake claude binary on the product PATH`,
        )
      }
      continue
    }
    // Claude must resolve only to our fake CLI bin dir, not ambient installs.
    if (binary === "claude") {
      const expected = join(options.fakeCliBinDir, "claude")
      if (
        found !== expected &&
        !found.startsWith(`${options.fakeCliBinDir}/`)
      ) {
        throw new Error(
          `${MODE_ENV}=no-opencode requires only the fake claude on PATH, but claude resolves to ${found}`,
        )
      }
      continue
    }
    throw new Error(
      `${MODE_ENV}=no-opencode requires ${binary} absent from the product PATH, but it resolves to ${found}`,
    )
  }
}

/**
 * Build the PATH for the Harness child: always prepend the fake-CLI bin dir;
 * in `no-opencode` mode, strip ambient Agent Backend CLI directories first.
 */
export const buildProductPath = (options: {
  readonly mode: AgentBackendE2eMode
  readonly fakeCliBinDir: string
  readonly ambientPath: string
}): string => {
  const base =
    options.mode === "no-opencode"
      ? pathWithoutBinaries(options.ambientPath, NO_OPENCODE_STRIPPED_BINARIES)
      : options.ambientPath
  return `${options.fakeCliBinDir}${delimiter}${base}`
}
