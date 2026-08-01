/**
 * Shared wire-format schemas and helpers for Keymaxxer-backed forge helper
 * processes (GitHub and GitLab).
 *
 * Producer helpers JSON.stringify domain values; these schemas decode stdout
 * back into typed service shapes so both layers cannot drift.
 */
import { Effect, Schema, SchemaTransformation } from "effect"
import type { ReadyLabeledIssue } from "@ready-for-agent/github-service"
import { sanitizeUserFacingText } from "@ready-for-agent/github-service"

/** Minimal repository identity shared by GitHub and GitLab forge types. */
type ForgeRepositoryRef = {
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)
const UrlString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      try {
        new URL(value)
        return undefined
      } catch {
        return "Invalid URL"
      }
    }),
  ),
)

/**
 * Helper wire values for optional instants: JSON null or an ISO-ish string.
 * Invalid / unparseable strings decode to null (same as the former
 * `decodeOptionalInstant` post-step), never to Invalid Date.
 */
const OptionalInstantFromString = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Date),
    SchemaTransformation.transform({
      decode: (value) => {
        if (value === null) {
          return null
        }
        const parsed = new Date(value)
        if (Number.isNaN(parsed.getTime())) {
          return null
        }
        return parsed
      },
      encode: (value) => (value === null ? null : value.toISOString()),
    }),
  ),
)

const SerializedIssue = Schema.Struct({
  number: PositiveInt,
  title: RequiredString,
  body: Schema.String,
  url: UrlString,
  createdAt: Schema.DateFromString,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.NullOr(RequiredString),
  hierarchySupported: Schema.Boolean,
  hasChildren: Schema.Boolean,
  parentPosition: Schema.NullOr(NonNegativeInt),
  parent: Schema.NullOr(
    Schema.Struct({
      number: PositiveInt,
      url: UrlString,
      state: Schema.Literals(["OPEN", "CLOSED"]),
      isReadyLabeled: Schema.Boolean,
    }),
  ),
  blockedBy: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      url: UrlString,
    }),
  ),
  closingPullRequests: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      repository: RequiredString,
      state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
      isDraft: Schema.Boolean,
    }),
  ),
})

const SerializedIssues = Schema.Array(SerializedIssue)

const SerializedTerminalPrStatusCheck = Schema.Struct({
  externalId: Schema.String,
  name: Schema.String,
  outcome: Schema.Literals(["green", "red"]),
})

const SerializedPrStatusCheckLogFetch = Schema.Union([
  Schema.TaggedStruct("ok", {
    excerpt: Schema.String,
    localPath: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("unavailable", {
    reason: Schema.String,
  }),
])

const SerializedPrStatusCheckDiagnostic = Schema.Struct({
  externalId: Schema.String,
  name: Schema.String,
  source: Schema.Literals(["actions-job", "status", "gitlab-job", "unknown"]),
  htmlUrl: Schema.NullOr(Schema.String),
  logFetch: SerializedPrStatusCheckLogFetch,
})

export const SerializedPrStatusCheckDiagnostics = Schema.Array(
  SerializedPrStatusCheckDiagnostic,
)

const SerializedPullRequestCheckStatusFields = {
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  baseRefName: Schema.NullOr(Schema.String),
  headPushedAt: OptionalInstantFromString,
  headSha: Schema.NullOr(Schema.String),
  createdAt: OptionalInstantFromString,
  isDraft: Schema.NullOr(Schema.Boolean),
} as const

export const SerializedPullRequestCheckStatus = Schema.Union([
  Schema.TaggedStruct("pending", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("expected", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("no_checks", {
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("succeeded", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("failed", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("closed", {
    ...SerializedPullRequestCheckStatusFields,
  }),
])

export const SerializedPullRequestLifecycleStatus = Schema.Union([
  Schema.TaggedStruct("open", {}),
  Schema.TaggedStruct("merged", {}),
  Schema.TaggedStruct("closed", {}),
  Schema.TaggedStruct("not_found", {}),
])

export const SerializedMergePullRequestResult = Schema.Union([
  Schema.TaggedStruct("merged", {}),
  Schema.TaggedStruct("revalidation", {
    reason: Schema.Literals([
      "head_changed",
      "checks_not_green",
      "mergeability_changed",
    ]),
    message: RequiredString,
  }),
  Schema.TaggedStruct("needs_human", {
    reason: Schema.Literals(["closed_unmerged", "merge_rejected"]),
    message: RequiredString,
  }),
])

/**
 * Factory for forge-specific request errors (`GitHubRequestError` /
 * `GitLabRequestError`). Keeps message shaping identical across layers.
 */
export const makeRequestError =
  <E>(ErrorClass: new (args: { readonly message: string }) => E) =>
  (repository: ForgeRepositoryRef, operation: string, detail?: string): E => {
    const cleaned =
      detail === undefined || detail.trim() === ""
        ? ""
        : sanitizeUserFacingText(detail, 300)
    return new ErrorClass({
      message:
        cleaned === ""
          ? `Failed to ${operation} for ${repository.projectPath}`
          : `Failed to ${operation} for ${repository.projectPath}: ${cleaned}`,
    })
  }

export const encodeArgument = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

export const encodedRepositoryArguments = (repository: ForgeRepositoryRef) =>
  [
    encodeArgument(repository.forge),
    encodeArgument(repository.forgeHost),
    encodeArgument(repository.projectPath),
  ] as const

export const parseSerializedIssues =
  <E>(
    requestError: (
      repository: ForgeRepositoryRef,
      operation: string,
      detail?: string,
    ) => E,
  ) =>
  (
    stdout: string,
    repository: ForgeRepositoryRef,
  ): Effect.Effect<readonly ReadyLabeledIssue[], E> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(SerializedIssues))(
      stdout,
    ).pipe(
      Effect.mapError(() =>
        requestError(repository, "list Ready-labeled Issues"),
      ),
    )
