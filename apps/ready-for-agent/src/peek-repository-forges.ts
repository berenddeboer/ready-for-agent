import { Database } from "bun:sqlite"

const resolveFilePath = (databasePath: string): string | undefined => {
  if (
    databasePath === ":memory:" ||
    databasePath.startsWith("libsql:") ||
    databasePath.trim() === ""
  ) {
    return undefined
  }

  return databasePath.startsWith("file://")
    ? databasePath.slice("file://".length)
    : databasePath.startsWith("file:")
      ? databasePath.slice("file:".length)
      : databasePath
}

export type RepositoryForge = "github" | "gitlab"

const REPOSITORY_FORGES: ReadonlyArray<RepositoryForge> = ["github", "gitlab"]

/**
 * Cold-start Forge preflight set from persisted Repositories.
 *
 * Missing/empty databases have no Repository tool requirements. A legacy
 * pre-forge-identity repository table is conservatively GitHub when non-empty,
 * matching the migration backfill.
 */
export const peekRepositoryForges = (
  databasePath: string,
): ReadonlyArray<RepositoryForge> => {
  const filePath = resolveFilePath(databasePath)
  if (filePath === undefined) {
    return []
  }

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      const hasRepositoryTable =
        db
          .query(
            `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name = 'repository'
           LIMIT 1`,
          )
          .values().length > 0
      if (!hasRepositoryTable) {
        return []
      }

      try {
        const rows = db
          .query(`SELECT DISTINCT lower(trim(forge)) AS forge FROM repository`)
          .values()
        const found = new Set<RepositoryForge>()
        for (const [forge] of rows) {
          if (forge === "github" || forge === "gitlab") {
            found.add(forge)
          }
        }
        return REPOSITORY_FORGES.filter((forge) => found.has(forge))
      } catch {
        const count = db
          .query(`SELECT COUNT(*) AS count FROM repository`)
          .values()[0]?.[0]
        const hasRows =
          (typeof count === "number" && count > 0) ||
          (typeof count === "bigint" && count > 0n)
        return hasRows ? ["github"] : []
      }
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
