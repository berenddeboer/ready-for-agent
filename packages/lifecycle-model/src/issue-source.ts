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
