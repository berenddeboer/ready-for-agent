import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CodexSessionStoreOptions,
  resolveCodexHome,
} from "./session-store.js"

export type CodexUserProvider =
  | { readonly kind: "firstParty" }
  | { readonly kind: "custom"; readonly providerId: string }
  | { readonly kind: "malformed"; readonly message: string }

/**
 * Built-in Codex provider IDs. Custom `model_providers.<id>` tables cannot
 * override these, and they are not the Azure/custom-provider inspect path.
 */
const BUILTIN_PROVIDER_IDS = new Set([
  "openai",
  "ollama",
  "lmstudio",
  "amazon-bedrock",
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const isMissingPathError = (error: unknown): boolean =>
  isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")

const formatCodexCustomProviderConfigError = (input: {
  readonly reason: string
  readonly configPath?: string
}): string => {
  const location =
    input.configPath === undefined
      ? "`$CODEX_HOME/config.toml` (defaults to `~/.codex/config.toml`)"
      : `\`${input.configPath}\``
  return `Codex custom provider config is invalid: ${input.reason} Fix ${location}, then Recheck Agent Backend.`
}

const malformed = (input: {
  readonly reason: string
  readonly configPath?: string
}): CodexUserProvider => ({
  kind: "malformed",
  message: formatCodexCustomProviderConfigError(input),
})

const parseTomlDocument = (text: string): unknown => {
  const toml = Reflect.get(Bun, "TOML")
  const parse = Reflect.get(toml ?? {}, "parse")
  if (typeof parse !== "function") {
    throw new Error("Bun.TOML.parse is unavailable")
  }
  return parse(text)
}

/**
 * Interpret user-level Codex `config.toml` text to decide whether inspect
 * should treat the operator as first-party OpenAI or a custom provider.
 *
 * Does not run `[model_providers.<id>.auth].command`.
 */
export const interpretCodexUserConfig = (text: string): CodexUserProvider => {
  let parsed: unknown
  try {
    parsed = parseTomlDocument(text)
  } catch {
    return malformed({ reason: "config.toml is not valid TOML." })
  }

  if (!isRecord(parsed)) {
    return malformed({ reason: "config.toml must be a TOML table." })
  }

  if (!("model_provider" in parsed) || parsed.model_provider === undefined) {
    return { kind: "firstParty" }
  }

  if (typeof parsed.model_provider !== "string") {
    return malformed({ reason: "`model_provider` must be a string." })
  }

  const providerId = parsed.model_provider.trim()
  if (providerId === "" || BUILTIN_PROVIDER_IDS.has(providerId)) {
    return { kind: "firstParty" }
  }

  const providers = parsed.model_providers
  if (providers === undefined) {
    return malformed({
      reason: `model_provider "${providerId}" is not defined in [model_providers].`,
    })
  }
  if (!isRecord(providers)) {
    return malformed({ reason: "`model_providers` must be a table." })
  }

  const provider = providers[providerId]
  if (provider === undefined) {
    return malformed({
      reason: `model_provider "${providerId}" is not defined in [model_providers].`,
    })
  }
  if (!isRecord(provider)) {
    return malformed({
      reason: `[model_providers.${providerId}] must be a table.`,
    })
  }

  if (nonEmptyString(provider.base_url) === null) {
    return malformed({
      reason: `custom provider "${providerId}" is missing base_url.`,
    })
  }

  return { kind: "custom", providerId }
}

/**
 * Resolve the effective user-level Codex provider from `CODEX_HOME` or
 * `~/.codex/config.toml`. Missing config is first-party. Never executes a
 * configured provider token command.
 */
export const resolveCodexUserProvider = (
  options: CodexSessionStoreOptions = {},
): CodexUserProvider => {
  const configPath = join(resolveCodexHome(options), "config.toml")
  let text: string
  try {
    text = readFileSync(configPath, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "firstParty" }
    }
    const detail =
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : "unreadable config.toml"
    return malformed({
      reason: `could not read config.toml (${detail}).`,
      configPath,
    })
  }

  return interpretCodexUserConfig(text)
}
