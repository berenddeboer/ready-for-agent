/**
 * Actionable Issue fixtures for live e2e that open Implement With without
 * submitting (issue #1279).
 *
 * Seeds onto the Paused Repository so Repos lists a leaf and a parent with
 * one open leaf child. No Work Items are created, so the operator menus stay
 * available and Cancel cannot start work.
 */

import { E2E_GRAPHQL_URL } from "./constants.ts"
import { ensureLiveHarnessPersistence } from "./live-harness-seed.ts"
import {
  PAUSED_REPOSITORY_FIXTURE,
  seedPausedRepositoryFixture,
} from "./paused-repository-fixture.ts"

export const IMPLEMENT_WITH_ISSUE_FIXTURE = {
  repositoryId: PAUSED_REPOSITORY_FIXTURE.repositoryId,
  projectPath: PAUSED_REPOSITORY_FIXTURE.projectPath,
  leafIssueId: "issue-01KZW59SEED0REP0FXX0000001",
  leafIssueNumber: 300,
  parentIssueId: "issue-01KZW59SEED0REP0FXX0000002",
  parentIssueNumber: 301,
  childIssueId: "issue-01KZW59SEED0REP0FXX0000003",
  childIssueNumber: 302,
} as const

const IMPLEMENT_WITH_ISSUE_IDS = [
  IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueId,
  IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueId,
  IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueId,
] as const

type IssuePresenceRow = {
  readonly id: string
  readonly issueNumber: number
  readonly hasChildren: boolean
  readonly parent: { readonly issueNumber: number } | null
}

export const implementWithIssueFixturesArePresent = (
  issues: ReadonlyArray<IssuePresenceRow>,
): boolean => {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const leaf = byId.get(IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueId)
  const parent = byId.get(IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueId)
  const child = byId.get(IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueId)
  return (
    leaf?.issueNumber === IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueNumber &&
    leaf.hasChildren === false &&
    leaf.parent === null &&
    parent?.issueNumber === IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber &&
    parent.hasChildren === true &&
    parent.parent === null &&
    child?.issueNumber === IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueNumber &&
    child.hasChildren === false &&
    child.parent?.issueNumber === IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber
  )
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

const implementWithIssueFixturesPresent = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query ImplementWithIssues($repositoryId: ID!) {
          issues(repositoryId: $repositoryId) {
            id
            issueNumber
            hasChildren
            parent { issueNumber }
          }
        }`,
        variables: {
          repositoryId: IMPLEMENT_WITH_ISSUE_FIXTURE.repositoryId,
        },
      }),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as {
      data?: { issues?: ReadonlyArray<IssuePresenceRow> }
      errors?: ReadonlyArray<{ message: string }>
    }
    if (payload.errors?.length || payload.data?.issues === undefined) {
      return false
    }
    return implementWithIssueFixturesArePresent(payload.data.issues)
  } catch {
    return false
  }
}

/**
 * Seed a leaf Issue and a supported parent/child pair on the Paused
 * Repository. Callers that need first-run suppressed should still use
 * `ensureConfiguredDefaultBuildModel`.
 */
export const seedImplementWithIssueFixtures = async (): Promise<void> => {
  await seedPausedRepositoryFixture()
  const now = Date.now()
  const repositoryId = sqlLiteral(IMPLEMENT_WITH_ISSUE_FIXTURE.repositoryId)
  const projectPath = IMPLEMENT_WITH_ISSUE_FIXTURE.projectPath
  const issueUrl = (issueNumber: number) =>
    sqlLiteral(
      `https://github.com/${projectPath}/issues/${String(issueNumber)}`,
    )
  const deleteExisting = IMPLEMENT_WITH_ISSUE_IDS.map(
    (id) => `DELETE FROM issue WHERE id = ${sqlLiteral(id)};`,
  )
  const sql = [
    ...deleteExisting,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueId)},
       ${repositoryId},
       ${IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueNumber},
       'E2E Implement With leaf',
       '',
       ${issueUrl(IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueNumber)},
       'OPEN',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueId)},
       ${repositoryId},
       ${IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber},
       'E2E Implement With parent',
       '',
       ${issueUrl(IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber)},
       'OPEN',
       ${now},
       1,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, parent_issue_number, parent_issue_url,
       has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueId)},
       ${repositoryId},
       ${IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueNumber},
       'E2E Implement With child',
       '',
       ${issueUrl(IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueNumber)},
       'OPEN',
       ${now},
       ${IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber},
       ${issueUrl(IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber)},
       0,
       ${now},
       ${now}
     );`,
  ].join("\n")

  await ensureLiveHarnessPersistence({
    alreadyPresent: implementWithIssueFixturesPresent,
    sql,
  })
}
