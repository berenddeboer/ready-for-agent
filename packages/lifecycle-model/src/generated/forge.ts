// This file is generated from ontology/rfa.ttl.
// Run `bunx nx run lifecycle-model:generate` to update it.

import { Schema } from "effect"

export const FORGES = [
  "github",
  "gitlab",
  "azure-devops",
] as const

export const Forge = Schema.Literals(FORGES)
export type Forge = typeof Forge.Type

export const isForge = (value: unknown): value is Forge =>
  FORGES.some((forge) => forge === value)

export const ISSUE_TRACKERS = [
  "github",
  "gitlab",
  "azure-devops",
  "linear",
  "fp",
] as const

export const IssueTracker = Schema.Literals(ISSUE_TRACKERS)
export type IssueTracker = typeof IssueTracker.Type

export const isIssueTracker = (value: unknown): value is IssueTracker =>
  ISSUE_TRACKERS.some((tracker) => tracker === value)

export const DEFAULT_ISSUE_TRACKER_BY_FORGE = {
  "github": "github",
  "gitlab": "gitlab",
  "azure-devops": "azure-devops",
} as const satisfies Record<Forge, IssueTracker>

export const defaultIssueTrackerForForge = (forge: Forge): IssueTracker =>
  DEFAULT_ISSUE_TRACKER_BY_FORGE[forge]
