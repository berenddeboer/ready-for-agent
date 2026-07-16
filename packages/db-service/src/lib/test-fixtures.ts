import { Effect, Layer, Stream } from "effect"
import { DbService, type DbServiceShape } from "./db-service.js"
import type { RepositoryRecord } from "./types.js"

const unused = () => Effect.die("not used")

export const makeRepositoryRecord = (
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord => ({
  id: "repo-test",
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
  issuesReconciledAt: null,
  ...overrides,
})

export const stubDbService = (
  overrides: Partial<DbServiceShape> = {},
): DbServiceShape => ({
  repositoryChanges: Stream.never,
  issueChanges: Stream.never,
  notifyIssuesChanged: () => Effect.void,
  getConfig: unused(),
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
