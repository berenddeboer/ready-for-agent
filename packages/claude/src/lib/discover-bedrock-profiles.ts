import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  BedrockClient,
  type InferenceProfileSummary,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock"
import { Duration, Effect } from "effect"
import type { AgentModel } from "@ready-for-agent/agent-backend"
import {
  CLAUDE_THINKING_LEVELS,
  type ClaudeBedrockDiscoveryResult,
  type ClaudeDiscoverBedrockModels,
} from "./types.js"

/**
 * One raw Bedrock inference profile summary used for catalog mapping tests
 * and the AWS SDK adapter (issues #820 / #821).
 */
export type BedrockInferenceProfileSummary = {
  readonly inferenceProfileId?: string | null
  readonly inferenceProfileName?: string | null
  readonly inferenceProfileArn?: string | null
  readonly status?: string | null
  readonly type?: string | null
  readonly models?: ReadonlyArray<{
    readonly modelArn?: string | null
  }> | null
}

export type DiscoverBedrockModelsInput = {
  /**
   * Process environment used for region resolution. Credentials follow the
   * ambient AWS default provider chain (not reconstructed from this map alone).
   */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** Optional bound for the control-plane list (default 15s). */
  readonly timeout?: Duration.Input
}

/**
 * Result of a best-effort Bedrock inference-profile discovery. Always Ready-
 * compatible: failures yield an empty catalog and an operator-facing warning.
 */
export type DiscoverBedrockModelsResult = ClaudeBedrockDiscoveryResult

/**
 * Injectable catalog discovery for Claude Code Bedrock inspect (tests inject
 * a fake; production uses {@link discoverBedrockModelsFromAws}).
 */
export type DiscoverBedrockModels = ClaudeDiscoverBedrockModels

/** Default bound when inspect does not pass a timeout. */
export const DEFAULT_BEDROCK_DISCOVERY_TIMEOUT = Duration.seconds(15)

/** Stable AgentModel.kind for AWS system-defined inference profiles. */
export const BEDROCK_PROFILE_KIND_SYSTEM_DEFINED = "SYSTEM_DEFINED"

/** Stable AgentModel.kind for organization application inference profiles. */
export const BEDROCK_PROFILE_KIND_APPLICATION = "APPLICATION"

const FREE_TEXT_HINT = "Free-text Agent Model entry remains available."

const discoveryWarning = (detail: string): string =>
  `Could not list Amazon Bedrock inference profiles: ${detail}. ${FREE_TEXT_HINT}`

/**
 * Soft warning when the control plane returns summaries but none survive the
 * ACTIVE / Anthropic / system-or-application filters (issues #820 / #821).
 */
export const EMPTY_BEDROCK_CATALOG_WARNING = `No active Anthropic Bedrock inference profiles were returned for this account/region; use free-text or check region/model access. ${FREE_TEXT_HINT}`

/**
 * Strip access keys, session tokens, bearer tokens, and other credential-like
 * payloads from operator-facing discovery warnings (issue #822).
 */
export const scrubBedrockDiscoverySecrets = (text: string): string => {
  let scrubbed = text
  // IAM access key ids (long-term AKIA… and temporary ASIA…).
  scrubbed = scrubbed.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
  // Env-style, property-style, and JSON-ish secret field assignments.
  scrubbed = scrubbed.replace(
    /\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_BEARER_TOKEN_BEDROCK|AWS_ACCESS_KEY_ID|aws_secret_access_key|aws_session_token|aws_access_key_id|secretAccessKey|SecretAccessKey|accessKeyId|AccessKeyId|sessionToken|SessionToken|security.?token)\b\s*[=:]\s*"?[^"\s,}]+"?/gi,
    (match) => {
      const keyMatch = match.match(/^([^=:]+)/)
      const key = (keyMatch?.[1] ?? "secret").trim()
      const separator = match.includes("=") ? "=" : ":"
      return `${key}${separator}[redacted]`
    },
  )
  // JSON `"secretAccessKey": "…"` / `"accessKeyId":"…"` forms.
  scrubbed = scrubbed.replace(
    /"(?:secretAccessKey|SecretAccessKey|accessKeyId|AccessKeyId|sessionToken|SessionToken|aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_ACCESS_KEY_ID)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const keyMatch = match.match(/^"([^"]+)"/)
      const key = keyMatch?.[1] ?? "secret"
      return `"${key}":"[redacted]"`
    },
  )
  // Authorization / bearer headers.
  scrubbed = scrubbed.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "Bearer [redacted]",
  )
  return scrubbed
}

export type ResolveBedrockRegionOptions = {
  /**
   * Read shared AWS config for named-profile region. Tests inject a fake;
   * production reads from disk (or returns null when the file is missing).
   */
  readonly readTextFile?: (path: string) => string | null
  /** Override home directory used when resolving `~/.aws/config`. */
  readonly homeDirectory?: string
}

const defaultReadTextFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * Parse a shared AWS config file for the `region` of a named profile.
 * Supports `[default]` and `[profile name]` sections only (issue #822).
 */
export const regionFromAwsConfigText = (
  configText: string,
  profileName: string,
): string | undefined => {
  const target =
    profileName.trim() === "" || profileName.trim() === "default"
      ? "default"
      : profileName.trim()
  const lines = configText.split(/\r?\n/)
  let inTarget = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue
    }
    const section = line.match(/^\[(.+)\]$/)
    if (section !== null) {
      const heading = (section[1] ?? "").trim()
      if (target === "default") {
        inTarget = heading === "default" || heading === "profile default"
      } else {
        inTarget =
          heading === `profile ${target}` ||
          // Rare but valid: bare `[name]` in some tooling; accept equality.
          heading === target
      }
      continue
    }
    if (!inTarget) {
      continue
    }
    const regionMatch = line.match(/^region\s*=\s*(.+)$/i)
    if (regionMatch !== null) {
      // Strip end-of-line comments and optional surrounding quotes so values
      // like `region = "us-east-1"` or `region = us-east-1 # comment` resolve.
      let value = (regionMatch[1] ?? "").trim()
      const commentIndex = value.search(/\s+[#;]/)
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trim()
      }
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).trim()
      }
      if (value.length > 0) {
        return value
      }
    }
  }
  return undefined
}

/**
 * Resolve the Bedrock control-plane region from the supported harness process
 * environment (issue #822):
 *
 * 1. `AWS_REGION`
 * 2. `AWS_DEFAULT_REGION`
 * 3. `region` for `AWS_PROFILE` (or `default`) in the shared AWS config file
 *    (`AWS_CONFIG_FILE` or `~/.aws/config`)
 * 4. `undefined` — Bedrock client omits an explicit region so the AWS SDK
 *    default provider chain can still resolve ambient region sources
 */
export const resolveBedrockRegion = (
  environment: Readonly<Record<string, string | undefined>>,
  options: ResolveBedrockRegionOptions = {},
): string | undefined => {
  const region = environment.AWS_REGION?.trim()
  if (region !== undefined && region.length > 0) {
    return region
  }
  const defaultRegion = environment.AWS_DEFAULT_REGION?.trim()
  if (defaultRegion !== undefined && defaultRegion.length > 0) {
    return defaultRegion
  }

  const profile = environment.AWS_PROFILE?.trim() || "default"
  const readTextFile = options.readTextFile ?? defaultReadTextFile
  const homeDirectory = options.homeDirectory ?? homedir()
  const configPath =
    environment.AWS_CONFIG_FILE?.trim() || join(homeDirectory, ".aws", "config")
  const configText = readTextFile(configPath)
  if (configText !== null) {
    const fromProfile = regionFromAwsConfigText(configText, profile)
    if (fromProfile !== undefined) {
      return fromProfile
    }
  }
  return undefined
}

const isAnthropicBacked = (
  profile: BedrockInferenceProfileSummary,
): boolean => {
  const id = profile.inferenceProfileId?.trim() ?? ""
  // System-defined Claude profile ids embed `anthropic.` (e.g. us.anthropic.…).
  if (id.includes("anthropic.")) {
    return true
  }
  // Do not treat the inference-profile ARN as an Anthropic signal: system
  // profile ARNs embed the profile id path, but application ARNs do not, and
  // default test fixtures can attach a system ARN to non-Anthropic summaries.
  // Rely on backing foundation-model ARNs (and profile id above).
  const models = profile.models
  if (models === undefined || models === null || models.length === 0) {
    return false
  }
  return models.some((model) => {
    const modelArn = model.modelArn?.trim() ?? ""
    // Foundation model ARNs embed `anthropic.` for Claude models.
    return modelArn.includes("anthropic.")
  })
}

const trimOrEmpty = (value: string | null | undefined): string =>
  value?.trim() ?? ""

/**
 * Executable Agent Model value for a raw profile summary.
 * System-defined → inference profile ID; application → ARN (issue #821).
 * Returns null when the summary is missing the required identifier.
 */
export const bedrockProfileExecutableId = (
  profile: BedrockInferenceProfileSummary,
): string | null => {
  const type = trimOrEmpty(profile.type)
  if (type === BEDROCK_PROFILE_KIND_SYSTEM_DEFINED) {
    const id = trimOrEmpty(profile.inferenceProfileId)
    return id.length > 0 ? id : null
  }
  if (type === BEDROCK_PROFILE_KIND_APPLICATION) {
    const arn = trimOrEmpty(profile.inferenceProfileArn)
    return arn.length > 0 ? arn : null
  }
  return null
}

const friendlyName = (
  profile: BedrockInferenceProfileSummary,
  executableId: string,
): string | null => {
  const name = trimOrEmpty(profile.inferenceProfileName)
  if (name.length === 0 || name === executableId) {
    return null
  }
  return name
}

const kindRank = (kind: string): number => {
  if (kind === BEDROCK_PROFILE_KIND_SYSTEM_DEFINED) {
    return 0
  }
  if (kind === BEDROCK_PROFILE_KIND_APPLICATION) {
    return 1
  }
  return 2
}

/**
 * Map raw ListInferenceProfiles summaries to the Claude Agent Model catalog.
 *
 * Keeps only ACTIVE Anthropic-backed SYSTEM_DEFINED and APPLICATION profiles.
 * System-defined entries use the inference profile ID as the persisted Agent
 * Model value; application entries use the ARN. Friendly AWS names and kind
 * metadata travel with the catalog for Settings presentation (issue #821).
 * Sorts system-defined before application, then by executable id; deduplicates
 * by executable id. Name is presentation-only and does not affect order.
 */
export const bedrockProfilesToAgentModels = (
  profiles: ReadonlyArray<BedrockInferenceProfileSummary>,
): ReadonlyArray<AgentModel> => {
  const thinkingLevels = [...CLAUDE_THINKING_LEVELS]
  const byId = new Map<string, AgentModel>()

  for (const profile of profiles) {
    if (profile.status !== "ACTIVE") {
      continue
    }
    const kind = trimOrEmpty(profile.type)
    if (
      kind !== BEDROCK_PROFILE_KIND_SYSTEM_DEFINED &&
      kind !== BEDROCK_PROFILE_KIND_APPLICATION
    ) {
      continue
    }
    if (!isAnthropicBacked(profile)) {
      continue
    }
    const id = bedrockProfileExecutableId(profile)
    if (id === null) {
      continue
    }
    if (byId.has(id)) {
      continue
    }
    const name = friendlyName(profile, id)
    byId.set(id, {
      id,
      thinkingLevels: [...thinkingLevels],
      ...(name !== null ? { name } : {}),
      kind,
    })
  }

  // Deterministic: system-defined before application, then by executable id.
  // Name is presentation-only and must not reorder equivalent rechecks.
  return [...byId.values()].sort((left, right) => {
    const kindCompare = kindRank(left.kind ?? "") - kindRank(right.kind ?? "")
    if (kindCompare !== 0) {
      return kindCompare
    }
    return left.id.localeCompare(right.id)
  })
}

/**
 * Attach the empty-catalog soft warning when filtering leaves no models.
 */
export const finalizeBedrockDiscoveryModels = (
  models: ReadonlyArray<AgentModel>,
): DiscoverBedrockModelsResult => ({
  models,
  warning: models.length === 0 ? EMPTY_BEDROCK_CATALOG_WARNING : null,
})

/**
 * Map AWS SDK / network failures to actionable operator warnings without
 * exposing credential material (issue #822). Distinguishes access denial,
 * expired/missing credentials, unresolved profile/region, throttling, and
 * generic Bedrock control-plane failures when the AWS response permits it.
 */
export const formatBedrockDiscoveryFailure = (error: unknown): string => {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name: unknown }).name === "string"
      ? (error as { name: string }).name
      : typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          typeof (error as { _tag: unknown })._tag === "string"
        ? (error as { _tag: string })._tag
        : ""
  const rawMessage =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message
      : typeof error === "string"
        ? error
        : "control-plane request failed"
  const message = scrubBedrockDiscoverySecrets(rawMessage)

  const combined = `${name} ${message}`.toLowerCase()

  if (
    combined.includes("timeouterror") ||
    combined.includes("timeout") ||
    combined.includes("aborted") ||
    combined.includes("aborterror")
  ) {
    return discoveryWarning(
      "listing timed out; retry with Recheck Agent Backend",
    )
  }
  if (
    combined.includes("accessdenied") ||
    combined.includes("access denied") ||
    combined.includes("not authorized") ||
    combined.includes("unauthorized") ||
    combined.includes("is not authorized to perform")
  ) {
    return discoveryWarning(
      "access denied (optional catalog permission bedrock:ListInferenceProfiles missing or denied on the harness IAM principal)",
    )
  }
  // Named shared-config / AWS_PROFILE only. Avoid bare "profile" + credentials
  // conjunctions that also match IAM instance-profile / IMDS and Bedrock
  // inference-profile wording (review follow-ups for #822).
  if (
    combined.includes("profilenotfound") ||
    combined.includes("could not find credentials for profile") ||
    combined.includes("could not load credentials from profile") ||
    combined.includes("unknown profile") ||
    combined.includes("the config profile") ||
    combined.includes("aws_profile") ||
    combined.includes("shared config profile") ||
    /(?:^|[\s("'])profile\s+[\w./@+-]+\s+(?:could not be found|does not exist|was not found)/.test(
      combined,
    )
  ) {
    return discoveryWarning(
      "AWS named profile is unresolved or unavailable to the harness process (check AWS_PROFILE and shared config)",
    )
  }
  if (
    combined.includes("expiredtoken") ||
    combined.includes("expired token") ||
    combined.includes("token has expired") ||
    combined.includes("could not load credentials") ||
    combined.includes("credentials not found") ||
    combined.includes("unable to locate credentials") ||
    combined.includes("could not load credentials from any providers") ||
    combined.includes("security token") ||
    combined.includes("invalidclienttokenid") ||
    combined.includes("unrecognizedclient") ||
    combined.includes("invalididentitytoken") ||
    combined.includes("sso session") ||
    combined.includes("token is expired")
  ) {
    return discoveryWarning(
      "AWS credentials are missing, expired, or invalid for the harness process",
    )
  }
  if (
    combined.includes("throttl") ||
    combined.includes("toomanyrequests") ||
    combined.includes("rate exceeded") ||
    combined.includes("requestlimitexceeded") ||
    combined.includes("slowdown")
  ) {
    return discoveryWarning(
      "request throttled; retry with Recheck Agent Backend",
    )
  }
  if (
    combined.includes("could not resolve region") ||
    combined.includes("region is missing") ||
    combined.includes("region is not configured") ||
    combined.includes("missing region") ||
    combined.includes("region not configured") ||
    combined.includes("no region")
  ) {
    return discoveryWarning(
      "AWS region is not configured (set AWS_REGION or AWS_DEFAULT_REGION, or a region on the active AWS profile)",
    )
  }
  if (combined.includes("enotfound") || combined.includes("networkingerror")) {
    return discoveryWarning("Bedrock control plane is unreachable")
  }

  // Keep a short, scrubbed detail for other control-plane failures.
  const safeDetail = scrubBedrockDiscoverySecrets(
    message.replace(/\s+/g, " ").trim().slice(0, 160),
  )
  return discoveryWarning(
    safeDetail.length > 0 ? safeDetail : "Bedrock control-plane request failed",
  )
}

const toSummary = (
  profile: InferenceProfileSummary,
): BedrockInferenceProfileSummary => ({
  inferenceProfileId: profile.inferenceProfileId,
  inferenceProfileName: profile.inferenceProfileName,
  inferenceProfileArn: profile.inferenceProfileArn,
  status: profile.status,
  type: profile.type,
  models: profile.models?.map((model) => ({ modelArn: model.modelArn })),
})

/**
 * Exhaust ListInferenceProfiles pagination via the AWS SDK Bedrock client.
 * Does not shell out to the AWS CLI. Lists both system-defined and application
 * profiles (no typeEquals filter — issue #821).
 */
export const listAllInferenceProfileSummaries = async (options: {
  readonly region?: string
  readonly abortSignal?: AbortSignal
}): Promise<ReadonlyArray<BedrockInferenceProfileSummary>> => {
  const client = new BedrockClient(
    options.region !== undefined ? { region: options.region } : {},
  )
  try {
    const collected: BedrockInferenceProfileSummary[] = []
    let nextToken: string | undefined
    do {
      if (options.abortSignal?.aborted === true) {
        throw new DOMException("Bedrock discovery aborted", "AbortError")
      }
      const response = await client.send(
        new ListInferenceProfilesCommand({
          maxResults: 100,
          // Omit typeEquals so system-defined and application profiles both
          // appear; client-side mapping filters and maps executable ids.
          ...(nextToken !== undefined ? { nextToken } : {}),
        }),
        options.abortSignal !== undefined
          ? { abortSignal: options.abortSignal }
          : undefined,
      )
      for (const profile of response.inferenceProfileSummaries ?? []) {
        collected.push(toSummary(profile))
      }
      nextToken = response.nextToken
    } while (nextToken !== undefined && nextToken.length > 0)
    return collected
  } finally {
    client.destroy()
  }
}

class BedrockDiscoveryError extends Error {
  readonly _tag = "BedrockDiscoveryError" as const
  readonly discoveryCause: unknown
  constructor(discoveryCause: unknown) {
    super("Bedrock inference profile discovery failed")
    this.name = "BedrockDiscoveryError"
    this.discoveryCause = discoveryCause
  }
}

const isTimeoutError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: string })._tag === "TimeoutError"

/**
 * Production discoverer: ambient AWS credential chain + region from the
 * harness process environment (or named-profile defaults via the SDK).
 * Bounded by timeout with AbortSignal so a hung control plane cannot stall
 * Ready inspect (issue #820 review).
 */
export const discoverBedrockModelsFromAws: DiscoverBedrockModels = (input) =>
  Effect.gen(function* () {
    const timeout = input.timeout ?? DEFAULT_BEDROCK_DISCOVERY_TIMEOUT
    const controller = new AbortController()

    const list = Effect.tryPromise({
      try: async () => {
        const region = resolveBedrockRegion(input.environment)
        const profiles = await listAllInferenceProfileSummaries({
          ...(region !== undefined ? { region } : {}),
          abortSignal: controller.signal,
        })
        return finalizeBedrockDiscoveryModels(
          bedrockProfilesToAgentModels(profiles),
        )
      },
      catch: (error) => new BedrockDiscoveryError(error),
    }).pipe(
      Effect.timeout(timeout),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          controller.abort()
        }),
      ),
    )

    return yield* list.pipe(
      Effect.catch((error) => {
        controller.abort()
        if (isTimeoutError(error)) {
          return Effect.succeed({
            models: [] as ReadonlyArray<AgentModel>,
            warning: formatBedrockDiscoveryFailure(error),
          })
        }
        return Effect.succeed({
          models: [] as ReadonlyArray<AgentModel>,
          warning: formatBedrockDiscoveryFailure(
            error instanceof BedrockDiscoveryError
              ? error.discoveryCause
              : error,
          ),
        })
      }),
    )
  })

/**
 * Successful discovery result helper for tests (no warning).
 */
export const bedrockModelsSuccess = (
  models: ReadonlyArray<AgentModel>,
): DiscoverBedrockModelsResult => ({
  models,
  warning: null,
})

/**
 * Failed discovery result helper for tests (empty catalog + warning).
 */
export const bedrockModelsFailure = (
  warning: string,
): DiscoverBedrockModelsResult => ({
  models: [],
  warning,
})
