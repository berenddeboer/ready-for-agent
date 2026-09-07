import type { Duration } from "effect"

export interface CodexLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  /**
   * Override process environment for Codex inspect/turn spawns (tests).
   * Production omits this so the harness process env is inherited.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Actionable readiness-failure copy when `codex login status` reports no auth
 * and user-level config does not select a valid custom model provider.
 *
 * `codex login status` reads stored login only and ignores `OPENAI_API_KEY`,
 * so that env var is not offered as inspect remediation.
 */
export const CODEX_UNAUTHENTICATED_MESSAGE =
  "Codex Build is not authenticated. Run `codex login` to store ChatGPT or API-key credentials, or set `model_provider` to a custom provider in `~/.codex/config.toml`, then Recheck Agent Backend."

/**
 * Codex CLI baseline for reliable first-party `model/list` discovery and
 * bundled Astra visibility. Older CLIs may lack app-server model listing or
 * ship Astra as hidden.
 */
export const CODEX_MIN_CLI_VERSION = "0.153.4"

const CODEX_DISCOVERY_RECOVERY = `Upgrade Codex CLI to ${CODEX_MIN_CLI_VERSION} or later, then Recheck Agent Backend.`

/**
 * First-party inspect could not obtain a usable catalogue from a short-lived
 * `codex app-server` `model/list` session.
 */
export const CODEX_APP_SERVER_DISCOVERY_FAILED_MESSAGE = (
  detail: string,
): string =>
  `Codex Build could not list Agent Models (${detail}). ${CODEX_DISCOVERY_RECOVERY}`

/**
 * Custom-provider inspect parsed `codex debug models --bundled` but nothing
 * survived picker visibility / API-eligibility projection.
 */
export const CODEX_BUNDLED_CATALOG_EMPTY_MESSAGE = `Codex custom-provider inspection found no picker-visible bundled models. This catalogue is the CLI's shipped models, not arbitrary custom-provider deployment IDs. ${CODEX_DISCOVERY_RECOVERY}`

/**
 * Custom-provider inspect received non-JSON or unusable bundled output.
 */
export const CODEX_BUNDLED_CATALOG_MALFORMED_MESSAGE = (
  detail: string,
): string =>
  `Codex custom-provider inspection could not read \`codex debug models --bundled\` (${detail}). ${CODEX_DISCOVERY_RECOVERY}`
