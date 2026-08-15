import { READY_FOR_AGENT_VERSION } from "./generated/version.ts"

/** Default Harness UI / GraphQL loopback origin (port 6056). */
export const DEFAULT_HARNESS_BASE_URL = "http://127.0.0.1:6056"

/** Single-line start remedy for unreachable-Harness failures. */
export const HARNESS_START_HINT = "Start it with: ready-for-agent start"

/** Single-line restart remedy when the running Harness is older than this CLI. */
export const HARNESS_RESTART_UPGRADE_HINT =
  "Restart the Harness to upgrade: ready-for-agent start"

/** CLI-owned code when the GraphQL transport cannot reach the Harness. */
export const HARNESS_UNREACHABLE_CODE = "HARNESS_UNREACHABLE"

/**
 * CLI-owned code when the Harness GraphQL schema is missing a field this CLI
 * requires — typically a newer CLI against an older still-running Harness.
 */
export const HARNESS_VERSION_MISMATCH_CODE = "HARNESS_VERSION_MISMATCH"

const GRAPHQL_VALIDATION_FAILED_CODE = "GRAPHQL_VALIDATION_FAILED"

/**
 * Fallback when a GraphQL response has no usable `extensions.code`.
 * Domain failures from the Harness always supply a stable code.
 */
export const GRAPHQL_ERROR_CODE = "GRAPHQL_ERROR"

/** CLI-owned code when the configured GraphQL URL returned HTML, not GraphQL. */
export const GRAPHQL_URL_NOT_ENDPOINT_CODE = "GRAPHQL_URL_NOT_ENDPOINT"

/** Minimal GenqlError shape (generated client is @ts-nocheck; duck-type safely). */
type GenqlErrorLike = Error & {
  readonly errors: ReadonlyArray<{
    readonly message?: string
    readonly extensions?: Record<string, unknown>
  }>
}

const isGenqlErrorLike = (cause: unknown): cause is GenqlErrorLike =>
  cause instanceof Error &&
  "errors" in cause &&
  Array.isArray((cause as { errors: unknown }).errors)

/**
 * Derive the operator-facing Harness base URL from a GraphQL endpoint URL
 * (strip a trailing `/graphql`). Falls back to the product default.
 */
export const harnessBaseUrlFromGraphqlUrl = (graphqlUrl: string): string => {
  const trimmed = graphqlUrl.trim().replace(/\/+$/, "")
  if (trimmed.length === 0) {
    return DEFAULT_HARNESS_BASE_URL
  }
  const withoutGraphql = trimmed.replace(/\/graphql$/i, "")
  return withoutGraphql.length > 0 ? withoutGraphql : DEFAULT_HARNESS_BASE_URL
}

/** User-facing message when the GraphQL target is the local Harness and it is down. */
export const harnessNotRunningMessage = (
  harnessBaseUrl: string = DEFAULT_HARNESS_BASE_URL,
): string =>
  `Harness is not running at ${harnessBaseUrl}\n${HARNESS_START_HINT}`

const urlPathEndsWithGraphql = (configuredUrl: string): boolean => {
  try {
    const pathname = new URL(configuredUrl).pathname.replace(/\/+$/, "")
    return pathname.toLowerCase().endsWith("/graphql")
  } catch {
    return configuredUrl
      .trim()
      .replace(/\/+$/, "")
      .toLowerCase()
      .endsWith("/graphql")
  }
}

/** Operator-facing message when the configured GraphQL URL returned HTML. */
const graphqlUrlNotEndpointMessage = (configuredUrl: string): string => {
  const htmlNotice = `${configuredUrl} returned HTML (the Harness UI), not GraphQL.`
  if (urlPathEndsWithGraphql(configuredUrl)) {
    return htmlNotice
  }
  const suggestedUrl = `${configuredUrl.trim().replace(/\/+$/, "")}/graphql`
  return `${htmlNotice} Set READY_FOR_AGENT_GRAPHQL_URL=${suggestedUrl}`
}

/**
 * Thrown at the fetch boundary when the configured GraphQL URL returns a
 * non-JSON (typically HTML) response instead of a GraphQL payload.
 */
export class GraphqlUrlNotEndpointError extends Error {
  readonly code = GRAPHQL_URL_NOT_ENDPOINT_CODE
  readonly configuredUrl: string

  constructor(configuredUrl: string) {
    super(graphqlUrlNotEndpointMessage(configuredUrl))
    this.name = "GraphqlUrlNotEndpointError"
    this.configuredUrl = configuredUrl
  }
}

const collectErrorText = (cause: unknown): string => {
  const parts: string[] = []
  let current: unknown = cause
  for (
    let depth = 0;
    depth < 5 && current !== undefined && current !== null;
    depth++
  ) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.join("\n")
}

export const isGraphqlUnreachable = (cause: unknown): boolean => {
  const text = collectErrorText(cause).toLowerCase()
  return (
    text.includes("econnrefused") ||
    text.includes("connection refused") ||
    text.includes("unable to connect") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("network error") ||
    text.includes("connecterror") ||
    text.includes("socket hang up") ||
    text.includes("enotfound")
  )
}

export type FormatGraphqlRequestFailureOptions = {
  /** Configured GraphQL URL; used to print the Harness origin when unreachable. */
  readonly graphqlUrl?: string
  /** This CLI's product version (`0.22.0` or `v0.22.0`). */
  readonly cliVersion?: string
  /** Running Harness product version, when the CLI could read one. */
  readonly harnessVersion?: string
}

/** Structured GraphQL/transport failure for the CLI JSON error seam. */
export type GraphqlFailureInfo = {
  readonly code: string
  readonly message: string
}

const graphqlErrorCode = (cause: GenqlErrorLike): string => {
  const first = cause.errors[0]
  const code = first?.extensions?.code
  return typeof code === "string" && code.length > 0 ? code : GRAPHQL_ERROR_CODE
}

/** GraphQL fields this CLI queries or mutates against the Harness. */
const CLI_REQUIRED_GRAPHQL_FIELDS = {
  addRepository: "add",
  intakeCandidates: "candidates",
  startRepositoryIntake: "intake",
  retryWorkItems: "retry",
  kanbanStatus: "status",
  workItemBySessionId: "jump",
} as const

type CliRequiredGraphqlField = keyof typeof CLI_REQUIRED_GRAPHQL_FIELDS

const isCliRequiredGraphqlField = (
  field: string,
): field is CliRequiredGraphqlField =>
  Object.hasOwn(CLI_REQUIRED_GRAPHQL_FIELDS, field)

const missingGraphqlFieldName = (message: string): string | undefined => {
  const match = /Cannot query field "([^"]+)"/.exec(message)
  const field = match?.[1]
  return field !== undefined && field.length > 0 ? field : undefined
}

const productVersionLabel = (version: string): string => {
  const trimmed = version.trim()
  if (trimmed.length === 0) {
    return "v0.0.0"
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`
}

export const harnessVersionMismatchMessage = (options: {
  readonly cliVersion: string
  readonly harnessVersion?: string
  readonly harnessBaseUrl: string
  readonly command: string
}): string => {
  const cliLabel = productVersionLabel(options.cliVersion)
  const command = `\`${options.command}\``
  if (
    options.harnessVersion !== undefined &&
    options.harnessVersion.trim().length > 0
  ) {
    const harnessLabel = productVersionLabel(options.harnessVersion)
    return `This CLI is ${cliLabel} but the Harness on ${options.harnessBaseUrl} is ${harnessLabel}, which does not support ${command}. ${HARNESS_RESTART_UPGRADE_HINT}`
  }
  return `This CLI is ${cliLabel} but the Harness on ${options.harnessBaseUrl} does not support ${command}. ${HARNESS_RESTART_UPGRADE_HINT}`
}

const versionMismatchFromMissingField = (
  cause: GenqlErrorLike,
  options?: FormatGraphqlRequestFailureOptions,
): GraphqlFailureInfo | undefined => {
  const message =
    cause.message.length > 0 ? cause.message : "GraphQL request failed"
  const field = missingGraphqlFieldName(message)
  if (field === undefined || !isCliRequiredGraphqlField(field)) {
    return undefined
  }
  const code = graphqlErrorCode(cause)
  if (code !== GRAPHQL_VALIDATION_FAILED_CODE && code !== GRAPHQL_ERROR_CODE) {
    return undefined
  }
  const harnessBaseUrl =
    options?.graphqlUrl === undefined
      ? DEFAULT_HARNESS_BASE_URL
      : harnessBaseUrlFromGraphqlUrl(options.graphqlUrl)
  return {
    code: HARNESS_VERSION_MISMATCH_CODE,
    message: harnessVersionMismatchMessage({
      cliVersion: options?.cliVersion ?? READY_FOR_AGENT_VERSION,
      harnessVersion: options?.harnessVersion,
      harnessBaseUrl,
      command: CLI_REQUIRED_GRAPHQL_FIELDS[field],
    }),
  }
}

/**
 * Map a GraphQL client failure to a stable code + operator-facing message.
 * Unreachable transport uses the CLI-owned `HARNESS_UNREACHABLE` code.
 * HTML (or other non-JSON) at the configured URL uses `GRAPHQL_URL_NOT_ENDPOINT`.
 * A missing field this CLI requires uses `HARNESS_VERSION_MISMATCH`.
 * Domain failures retain Harness `extensions.code` from GenqlError.
 */
export const describeGraphqlFailure = (
  cause: unknown,
  options?: FormatGraphqlRequestFailureOptions,
): GraphqlFailureInfo => {
  if (cause instanceof GraphqlUrlNotEndpointError) {
    return {
      code: GRAPHQL_URL_NOT_ENDPOINT_CODE,
      message: cause.message,
    }
  }

  if (isGraphqlUnreachable(cause)) {
    const baseUrl =
      options?.graphqlUrl === undefined
        ? DEFAULT_HARNESS_BASE_URL
        : harnessBaseUrlFromGraphqlUrl(options.graphqlUrl)
    return {
      code: HARNESS_UNREACHABLE_CODE,
      message: harnessNotRunningMessage(baseUrl),
    }
  }

  if (isGenqlErrorLike(cause)) {
    const versionMismatch = versionMismatchFromMissingField(cause, options)
    if (versionMismatch !== undefined) {
      return versionMismatch
    }
    return {
      code: graphqlErrorCode(cause),
      message:
        cause.message.length > 0 ? cause.message : "GraphQL request failed",
    }
  }

  return {
    code: GRAPHQL_ERROR_CODE,
    message: cause instanceof Error ? cause.message : "GraphQL request failed",
  }
}

/** @deprecated Prefer `describeGraphqlFailure` when a stable code is needed. */
export const formatGraphqlRequestFailure = (
  cause: unknown,
  options?: FormatGraphqlRequestFailureOptions,
): string => describeGraphqlFailure(cause, options).message
