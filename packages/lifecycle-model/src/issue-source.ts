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
 * code-hosting Forge (Linear). Issue mutations and prompt identity use this
 * rather than the Repository's current Issue Tracker setting.
 */
export const forgeForIssueSource = (source: IssueSource): Forge | null =>
  isForge(source.tracker) ? source.tracker : null

/**
 * Existing Forge-hosted Issues use a positive integer as both native identity
 * and display identifier. Callers that still have only an issue number use
 * this to populate the distinct store/API fields.
 */
export const existingProviderIssueIdentity = (input: {
  readonly tracker: IssueTracker
  readonly issueNumber: number
}): {
  readonly issueTracker: IssueTracker
  readonly nativeId: string
  readonly displayId: string
} => ({
  issueTracker: input.tracker,
  nativeId: String(input.issueNumber),
  displayId: String(input.issueNumber),
})

/**
 * Fill native/display identity from a positive integer when a caller omitted
 * the distinct fields. Empty strings are treated as omitted.
 */
export const completeIssueIdentity = (input: {
  readonly issueNumber: number
  readonly nativeId?: string
  readonly displayId?: string
}): { readonly nativeId: string; readonly displayId: string } => ({
  nativeId:
    input.nativeId !== undefined && input.nativeId.length > 0
      ? input.nativeId
      : String(input.issueNumber),
  displayId:
    input.displayId !== undefined && input.displayId.length > 0
      ? input.displayId
      : String(input.issueNumber),
})

/**
 * Human-readable Issue label. Numeric display identifiers keep the existing
 * `#42` form; tracker keys such as Linear's `ENG-123` are shown as-is.
 */
export const formatIssueDisplayId = (displayId: string): string =>
  /^[0-9]+$/.test(displayId) ? `#${displayId}` : displayId
