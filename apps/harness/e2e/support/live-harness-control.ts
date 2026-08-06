/**
 * Control surface between Playwright steps (node) and the live-Harness
 * supervisor (bun).
 *
 * Two things a rendered Settings test needs that a plain `webServer` cannot
 * give it (issue #838):
 *
 * 1. **Legacy stored settings.** A model left over from another provider mode
 *    can no longer be written through GraphQL — that is the behavior under
 *    test — so it must be seeded straight into the Harness database.
 * 2. **A Harness restart.** Provider mode and the Agent Model catalog are
 *    cached indefinitely in the browser; only a restart proves Settings
 *    re-fetches them instead of serving what it learned before.
 *
 * Both are file-based so the step process never needs `bun:sqlite` or a
 * handle on the server process: steps drop a request in the control directory
 * and the supervisor (which owns the database and the child process) performs
 * it. The supervisor publishes its paths in a state file at a fixed location
 * so steps can find the directory without an environment handshake.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const supportDir = dirname(fileURLToPath(import.meta.url))

/** Written by the supervisor at startup; read by steps. Git-ignored. */
export const LIVE_HARNESS_STATE_FILE = resolve(
  supportDir,
  "../.live-harness-state.json",
)

export type LiveHarnessState = {
  /** Isolated SQLite database the Harness process is using. */
  readonly dbPath: string
  /** Directory holding the request/among-processes control files. */
  readonly controlDir: string
}

/** Claude readiness the fake `claude` binary reports on `auth status`. */
export type FakeClaudeMode = "firstParty" | "unauthenticated"

export const CONTROL_FILES = {
  /** Current {@link FakeClaudeMode}, read by the fake CLI on every probe. */
  claudeMode: "claude-mode",
  /** SQL applied against the stopped Harness database before the next start. */
  seedSql: "seed.sql",
  /** Presence requests a restart; the supervisor deletes it when it starts. */
  restart: "restart",
  /** Monotonic child-process generation, bumped after each spawn. */
  generation: "generation",
} as const

export const readLiveHarnessState = (): LiveHarnessState =>
  JSON.parse(readFileSync(LIVE_HARNESS_STATE_FILE, "utf8")) as LiveHarnessState

export const controlFilePath = (
  state: LiveHarnessState,
  file: (typeof CONTROL_FILES)[keyof typeof CONTROL_FILES],
): string => join(state.controlDir, file)

export const readGeneration = (state: LiveHarnessState): number => {
  try {
    return Number(
      readFileSync(controlFilePath(state, CONTROL_FILES.generation), "utf8"),
    )
  } catch {
    return 0
  }
}

export const writeControlFile = (
  state: LiveHarnessState,
  file: (typeof CONTROL_FILES)[keyof typeof CONTROL_FILES],
  contents: string,
): void => {
  writeFileSync(controlFilePath(state, file), contents)
}
