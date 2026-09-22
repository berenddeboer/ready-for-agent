import { Schema } from "effect"
import type { FpFailureKind } from "./errors.js"

/**
 * Pure parsers for fp CLI output, kept separate from process spawning so
 * they can be pinned against captured transcripts. Shapes observed on fp
 * 0.25.0; unknown keys are ignored, so additive CLI changes do not break them.
 */

const IsoDate = Schema.String

const FpListIssueSchema = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  priority: Schema.optional(Schema.NullOr(Schema.String)),
  parent: Schema.optional(Schema.NullOr(Schema.String)),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  createdAt: IsoDate,
  updatedAt: IsoDate,
})

/** `fp issue list --format json` wraps the array: `{ "issues": [...] }`. */
const FpListSchema = Schema.Struct({
  issues: Schema.Array(FpListIssueSchema),
})

const FpShowIssueSchema = Schema.Struct({
  id: Schema.String,
  displayId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  parent: Schema.optional(Schema.NullOr(Schema.String)),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  properties: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
})

export type FpListIssue = typeof FpListIssueSchema.Type
export type FpShowIssue = typeof FpShowIssueSchema.Type

const decodeJson = <S extends { readonly Type: unknown }>(
  schema: S & Parameters<typeof Schema.decodeUnknownSync>[0],
  text: string,
): S["Type"] => Schema.decodeUnknownSync(schema)(JSON.parse(text))

export const parseFpIssueList = (stdout: string): readonly FpListIssue[] =>
  decodeJson(FpListSchema, stdout).issues

export const parseFpIssueShow = (stdout: string): FpShowIssue =>
  decodeJson(FpShowIssueSchema, stdout)

/** Labels live in the `labels` property; absent or null means none. */
export const fpIssueLabels = (issue: FpShowIssue): readonly string[] =>
  issue.properties?.labels ?? []

const EMAIL_LINE = /^\s*Email:\s*(\S+)\s*$/m
const NAME_LINE = /^\s*Name:\s*(.+?)\s*$/m

/**
 * `fp auth status` has no JSON mode. It prints `Name:` and `Email:` lines
 * after a `Token valid` check; the email is the fp author identity.
 */
export const parseFpAuthStatus = (
  combinedOutput: string,
): { readonly name: string | null; readonly email: string } | null => {
  const email = EMAIL_LINE.exec(combinedOutput)?.[1]
  if (email === undefined || email === "") {
    return null
  }
  const name = NAME_LINE.exec(combinedOutput)?.[1] ?? null
  return { name, email }
}

const PROJECT_ID_LINE = /^\s*Project ID:\s*(\S+)\s*$/m
const WORKSPACE_LINE = /^\s*Workspace:\s*(\S+)\s*$/m

/**
 * `fp project remote` has no JSON mode. A linked project prints `Project ID:`
 * and `Workspace:` lines; an unlinked one prints `Project not linked to
 * remote` and exits 1, which parses to null.
 */
export const parseFpProjectRemote = (
  combinedOutput: string,
): { readonly workspaceSlug: string; readonly projectId: string } | null => {
  const projectId = PROJECT_ID_LINE.exec(combinedOutput)?.[1]
  const workspaceSlug = WORKSPACE_LINE.exec(combinedOutput)?.[1]
  if (
    projectId === undefined ||
    projectId === "" ||
    workspaceSlug === undefined ||
    workspaceSlug === ""
  ) {
    return null
  }
  return { workspaceSlug, projectId }
}

/** `fp --version` prints `0.25.0 (d818046)`. */
export const parseFpVersion = (stdout: string): string | null => {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout)
  return match?.[1] ?? null
}

/**
 * fp reports failures as prose on stdout or stderr with exit code 1. These
 * are the messages observed on 0.25.0; anything else is `unknown`.
 * `invalid_status` is only reachable from status writes (execution half).
 */
export const classifyFpFailure = (
  combinedOutput: string,
): Extract<
  FpFailureKind,
  "project_not_registered" | "issue_not_found" | "invalid_status" | "unknown"
> => {
  if (
    /\.fp directory not found/i.test(combinedOutput) ||
    /not registered with fp/i.test(combinedOutput)
  ) {
    return "project_not_registered"
  }
  if (/^Issue \S+ not found/im.test(combinedOutput)) {
    return "issue_not_found"
  }
  if (/Invalid status/i.test(combinedOutput)) {
    return "invalid_status"
  }
  return "unknown"
}
