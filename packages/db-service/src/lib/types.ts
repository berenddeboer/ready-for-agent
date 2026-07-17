import { Schema } from "effect"

export const RepositoryId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^repo-[0-9A-HJKMNP-TV-Z]{26}$/)),
  Schema.brand("RepositoryId"),
)
export type RepositoryId = typeof RepositoryId.Type

export interface AddRepositoryInput {
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
}

export interface RepositoryRecord {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
  readonly defaultModel: string | null
  readonly defaultVariant: string | null
  readonly reviewModel: string | null
  readonly reviewVariant: string | null
  readonly autoMerge: boolean
  readonly issuesReconciledAt: Date | null
}

export interface UpdateRepositorySettingsInput {
  readonly repositoryId: string
  readonly paused: boolean
  readonly defaultModel: string | null
  readonly defaultVariant: string | null
  readonly reviewModel: string | null
  readonly reviewVariant: string | null
  readonly autoMerge: boolean
}

export interface ConfigRecord {
  readonly defaultModel: string
  readonly defaultVariant: string
  readonly reviewModel: string | null
  readonly reviewVariant: string | null
  readonly maxConcurrentOpencodeSessions: number
  readonly maxConcurrentWorkItems: number
}

export interface UpdateConfigInput {
  readonly defaultModel: string
  readonly defaultVariant: string
  readonly reviewModel: string | null
  readonly reviewVariant: string | null
  readonly maxConcurrentOpencodeSessions: number
  readonly maxConcurrentWorkItems: number
}

export interface StoreIssueInput {
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: IssueState
  readonly githubCreatedAt: Date
  readonly parent: IssueReference | null
  readonly parentPosition: number | null
  readonly hasChildren: boolean
  readonly blockedBy: readonly IssueDependency[]
}

export type IssueState = "OPEN" | "CLOSED"

export interface IssueRecord {
  readonly id: string
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: IssueState
  readonly githubCreatedAt: Date
  readonly parent: IssueReference | null
  readonly parentPosition: number | null
  readonly hasChildren: boolean
  readonly blockedBy: readonly IssueDependency[]
}

export interface IssueReference {
  readonly githubIssueNumber: number
  readonly githubIssueUrl: string
}

export type IssueDependency = IssueReference

export interface WorkItemPullRequest {
  readonly githubIssueNumber: number
  readonly githubPullRequestNumber: number
}
