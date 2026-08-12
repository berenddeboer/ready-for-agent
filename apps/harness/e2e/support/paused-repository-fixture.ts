/**
 * Paused Repository persistence seed for live e2e that only need a
 * Repository to exist (issue #998).
 *
 * Seeds once per live Harness process via {@link ensureLiveHarnessPersistence}:
 * the first call writes the row against the stopped database and restarts;
 * later calls no-op when the Paused, already-reconciled fixture is present.
 * Does not clone the End-to-End Fixture Repository. The Project Path has no
 * vault secret, so vault-backed live e2e does not treat the row as credentialed
 * and does not activate Issue Polling or enqueue a Refresh Job.
 */

import { E2E_GRAPHQL_URL } from "./constants.ts"
import { ensureLiveHarnessPersistence } from "./live-harness-seed.ts"

/**
 * Branded entity IDs must match DB schema patterns
 * (`repo-` + 26 Crockford ULID chars, no I/L/O/U). Fixed fixture keeps
 * scenarios deterministic across restarts.
 */
export const PAUSED_REPOSITORY_FIXTURE = {
  repositoryId: "repo-01KZW59SEED0REP0FXX0000001",
  projectPath: "e2e/paused-repository",
} as const

type PausedRepositoryPresenceRow = {
  readonly id: string
  readonly paused: boolean
  readonly issuesReconciledAt: string | null
}

export const pausedRepositoryFixtureIsPresent = (
  repositories: ReadonlyArray<PausedRepositoryPresenceRow>,
): boolean => {
  const row = repositories.find(
    (repository) => repository.id === PAUSED_REPOSITORY_FIXTURE.repositoryId,
  )
  return row?.paused === true && row.issuesReconciledAt !== null
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

const pausedRepositoryFixturePresent = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query {
          repositories { id paused issuesReconciledAt }
        }`,
      }),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as {
      data?: {
        repositories?: ReadonlyArray<PausedRepositoryPresenceRow>
      }
      errors?: ReadonlyArray<{ message: string }>
    }
    if (payload.errors?.length || payload.data?.repositories === undefined) {
      return false
    }
    return pausedRepositoryFixtureIsPresent(payload.data.repositories)
  } catch {
    return false
  }
}

/**
 * Seed a Paused Repository whose Issue store is already marked reconciled so
 * Repos and Pipeline render without a live Forge round-trip. Paused so the
 * Harness does not autonomously select work.
 *
 * Does not write `config.default_model`: callers that need first-run
 * suppressed should use `ensureConfiguredDefaultBuildModel` after seeding.
 */
export const seedPausedRepositoryFixture = async (): Promise<void> => {
  const now = Date.now()
  const sql = [
    `DELETE FROM work_item WHERE repository_id = ${sqlLiteral(PAUSED_REPOSITORY_FIXTURE.repositoryId)};`,
    `DELETE FROM issue WHERE repository_id = ${sqlLiteral(PAUSED_REPOSITORY_FIXTURE.repositoryId)};`,
    `DELETE FROM repository WHERE id = ${sqlLiteral(PAUSED_REPOSITORY_FIXTURE.repositoryId)};`,
    // issues_reconciled_at must be set so Repos and Pipeline render the
    // projected Issue store without requiring a live Forge refresh.
    `INSERT INTO repository (
       id, forge, forge_host, project_path, local_path, is_bare, paused,
       issues_reconciled_at, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(PAUSED_REPOSITORY_FIXTURE.repositoryId)},
       'github',
       'github.com',
       ${sqlLiteral(PAUSED_REPOSITORY_FIXTURE.projectPath)},
       ${sqlLiteral(`/tmp/${PAUSED_REPOSITORY_FIXTURE.repositoryId}`)},
       0,
       1,
       ${now},
       ${now},
       ${now}
     );`,
  ].join("\n")

  await ensureLiveHarnessPersistence({
    alreadyPresent: pausedRepositoryFixturePresent,
    sql,
  })
}
