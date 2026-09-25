import { Schema } from "effect"
import { type Forge, IssueTracker, isForge } from "./generated/forge.js"

export const IssueSource = Schema.Struct({
  tracker: IssueTracker,
  nativeId: Schema.String,
  displayId: Schema.String,
  url: Schema.String,
})
export type IssueSource = typeof IssueSource.Type

export const forgeIssueSource = (input: {
  readonly tracker: IssueTracker
  readonly issueNumber: number
  readonly url: string
}): IssueSource => ({
  tracker: input.tracker,
  nativeId: String(input.issueNumber),
  displayId: String(input.issueNumber),
  url: input.url,
})

/**
 * Forge-hosted Original Issue Source, or null when the tracker is not a
 * code-hosting Forge (a tracker-only kind such as Linear). Issue mutations and prompt identity use this
 * rather than the Repository's current Issue Tracker setting.
 */
export const forgeForIssueSource = (source: IssueSource): Forge | null =>
  isForge(source.tracker) ? source.tracker : null

/**
 * Forge-hosted Issues use a positive integer as both native identity and
 * display identifier. Adapters emit this at the tracker boundary.
 */
export const forgeNumericIdentity = (
  issueNumber: number,
): { readonly nativeId: string; readonly displayId: string } => ({
  nativeId: String(issueNumber),
  displayId: String(issueNumber),
})

export const existingProviderIssueIdentity = (input: {
  readonly tracker: IssueTracker
  readonly issueNumber: number
}): {
  readonly issueTracker: IssueTracker
  readonly nativeId: string
  readonly displayId: string
} => ({
  issueTracker: input.tracker,
  ...forgeNumericIdentity(input.issueNumber),
})

/**
 * Empty persisted native/display columns still mean the issue number.
 */
export const persistedIssueIdentity = (input: {
  readonly issueNumber: number
  readonly nativeId?: string | null
  readonly displayId?: string | null
}): { readonly nativeId: string; readonly displayId: string } => ({
  nativeId:
    input.nativeId !== undefined &&
    input.nativeId !== null &&
    input.nativeId.length > 0
      ? input.nativeId
      : String(input.issueNumber),
  displayId:
    input.displayId !== undefined &&
    input.displayId !== null &&
    input.displayId.length > 0
      ? input.displayId
      : String(input.issueNumber),
})

/**
 * Human-readable Issue label. Numeric display identifiers keep the existing
 * `#42` form; tracker keys such as Linear's `ENG-123` are shown as-is.
 */
export const formatIssueDisplayId = (displayId: string): string =>
  /^[0-9]+$/.test(displayId) ? `#${displayId}` : displayId
