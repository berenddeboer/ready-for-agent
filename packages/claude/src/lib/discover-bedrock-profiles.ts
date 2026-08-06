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
 * and the AWS SDK adapter (issue #820).
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

const FREE_TEXT_HINT = "Free-text Agent Model entry remains available."

const discoveryWarning = (detail: string): string =>
  `Could not list Amazon Bedrock inference profiles: ${detail}. ${FREE_TEXT_HINT}`

/**
 * Soft warning when the control plane returns summaries but none survive the
 * ACTIVE / SYSTEM_DEFINED / Anthropic filters (issue #820 review).
 */
export const EMPTY_BEDROCK_SYSTEM_DEFINED_CATALOG_WARNING = `No active Anthropic system-defined inference profiles were returned for this account/region; use free-text or check region/model access. ${FREE_TEXT_HINT}`

/**
 * Resolve the Bedrock control-plane region from ambient env (AWS_REGION, then
 * AWS_DEFAULT_REGION). Named-profile region resolution is left to the AWS SDK
 * default chain when region is omitted.
 */
export const resolveBedrockRegion = (
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const region = environment.AWS_REGION?.trim()
  if (region !== undefined && region.length > 0) {
    return region
  }
  const defaultRegion = environment.AWS_DEFAULT_REGION?.trim()
  if (defaultRegion !== undefined && defaultRegion.length > 0) {
    return defaultRegion
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
  const models = profile.models
  if (models === undefined || models === null || models.length === 0) {
    return false
  }
  return models.some((model) => {
    const arn = model.modelArn?.trim() ?? ""
    // Foundation model ARNs embed `anthropic.` for Claude models.
    return arn.includes("anthropic.")
  })
}

/**
 * Map raw ListInferenceProfiles summaries to the Claude Agent Model catalog.
 *
 * Keeps only ACTIVE, SYSTEM_DEFINED profiles with at least one Anthropic-backed
 * signal (model ARN or profile id). Uses inference profile ID as the
 * persisted Agent Model value. Sorts by id and deduplicates.
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
    if (profile.type !== "SYSTEM_DEFINED") {
      continue
    }
    if (!isAnthropicBacked(profile)) {
      continue
    }
    const id = profile.inferenceProfileId?.trim() ?? ""
    if (id.length === 0) {
      continue
    }
    if (byId.has(id)) {
      continue
    }
    byId.set(id, { id, thinkingLevels: [...thinkingLevels] })
  }

  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

/**
 * Attach the empty-catalog soft warning when filtering leaves no models.
 */
export const finalizeBedrockDiscoveryModels = (
  models: ReadonlyArray<AgentModel>,
): DiscoverBedrockModelsResult => ({
  models,
  warning:
    models.length === 0 ? EMPTY_BEDROCK_SYSTEM_DEFINED_CATALOG_WARNING : null,
})

/**
 * Map AWS SDK / network failures to actionable operator warnings without
 * exposing credential material.
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
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message
      : typeof error === "string"
        ? error
        : "control-plane request failed"

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
    combined.includes("unauthorized")
  ) {
    return discoveryWarning(
      "access denied (need bedrock:ListInferenceProfiles on the harness IAM principal)",
    )
  }
  if (
    combined.includes("expiredtoken") ||
    combined.includes("expired token") ||
    combined.includes("could not load credentials") ||
    combined.includes("credentials not found") ||
    combined.includes("unable to locate credentials") ||
    combined.includes("security token") ||
    combined.includes("invalidclienttokenid") ||
    combined.includes("unrecognizedclient")
  ) {
    return discoveryWarning(
      "AWS credentials are missing, expired, or invalid for the harness process",
    )
  }
  if (
    combined.includes("throttl") ||
    combined.includes("toomanyrequests") ||
    combined.includes("rate exceeded")
  ) {
    return discoveryWarning(
      "request throttled; retry with Recheck Agent Backend",
    )
  }
  if (
    combined.includes("could not resolve region") ||
    combined.includes("region is missing") ||
    combined.includes("region is not configured") ||
    combined.includes("missing region")
  ) {
    return discoveryWarning(
      "AWS region is not configured (set AWS_REGION or AWS_DEFAULT_REGION, or a profile region)",
    )
  }
  if (combined.includes("enotfound") || combined.includes("networkingerror")) {
    return discoveryWarning("Bedrock control plane is unreachable")
  }

  // Keep a short, non-secret detail for other control-plane failures.
  const safeDetail = message.replace(/\s+/g, " ").trim().slice(0, 160)
  return discoveryWarning(
    safeDetail.length > 0 ? safeDetail : "control-plane request failed",
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
 * Does not shell out to the AWS CLI.
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
          // Server-side filter: APPLICATION profiles are out of scope for #820.
          typeEquals: "SYSTEM_DEFINED",
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
