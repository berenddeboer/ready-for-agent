import { Schema } from "effect"
import { IssueTracker } from "./generated/forge.js"

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
