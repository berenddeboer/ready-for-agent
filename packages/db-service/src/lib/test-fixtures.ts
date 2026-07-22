import { Effect, Layer, Stream } from "effect"
import { DbService, type DbServiceShape } from "./db-service.js"
import { RepositoryId, type RepositoryRecord } from "./types.js"

const unused = () => Effect.die("not used")

/** Default fixture repository id (valid `RepositoryId` brand). */
export const testRepositoryId = RepositoryId.make(
  "repo-01ARZ3NDEKTSV4RRFFQ69G5FAV",
)

export const makeRepositoryRecord = (
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord => ({
  id: testRepositoryId,
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/acme/widgets",
  isBare: true,
  paused: false,
  defaultModel: null,
  defaultVariant: null,
  reviewModel: null,
  reviewVariant: null,
  autoMerge: false,
  includeAllIssueAuthors: false,
  issuesReconciledAt: null,
  ...overrides,
})

export const stubDbService = (
  overrides: Partial<DbServiceShape> = {},
): DbServiceShape => ({
  repositoryChanges: Stream.never,
  issueChanges: Stream.never,
  workItemChanges: Stream.never,
  notifyIssuesChanged: () => Effect.void,
  notifyWorkItemsChanged: () => Effect.void,
  getConfig: Effect.succeed({
    defaultModel: "opencode/deepseek-v4-flash-free",
    defaultVariant: "low",
    reviewModel: null,
    reviewVariant: null,
    maxConcurrentOpencodeSessions: 2,
    maxConcurrentWorkItems: 5,
  }),
  updateConfig: unused,
  addRepository: unused,
  updateRepositorySettings: unused,
  pauseRepository: unused,
  unpauseRepository: unused,
  listRepositories: unused(),
  removeRepository: unused,
  storeIssue: unused,
  listIssues: unused,
  listWorkItemPullRequests: unused,
  deleteIssue: unused,
  markIssuesReconciled: unused,
  ...overrides,
})

export const stubDbServiceLayer = (
  overrides: Partial<DbServiceShape> = {},
): Layer.Layer<DbService> => Layer.succeed(DbService, stubDbService(overrides))
