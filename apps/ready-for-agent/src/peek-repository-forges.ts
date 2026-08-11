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

/** HTTPS endpoint a cold-start TLS preflight should probe. */
export type ForgeApiEndpoint = {
  readonly forge: RepositoryForge
  /** Hostname (and optional :port) used for the TLS handshake. */
  readonly host: string
  /** Path that yields a cheap HTTP response once TLS succeeds. */
  readonly path: string
}

const GITHUB_API_ENDPOINT: ForgeApiEndpoint = {
  forge: "github",
  host: "api.github.com",
  path: "/",
}

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

const normalizeHost = (value: string): string => {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "") return trimmed
  return trimmed.replace(/^www\./, "")
}

/**
 * Distinct forge API endpoints for TLS trust preflight.
 *
 * GitHub always probes `api.github.com` (one API host for all GitHub.com
 * Repositories). GitLab probes each distinct `forge_host` (self-hosted
 * instances differ). Empty/missing databases return no endpoints.
 */
export const peekForgeApiEndpoints = (
  databasePath: string,
): ReadonlyArray<ForgeApiEndpoint> => {
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
          .query(
            `SELECT DISTINCT
               lower(trim(forge)) AS forge,
               lower(trim(forge_host)) AS forge_host
             FROM repository`,
          )
          .values()
        const endpoints: ForgeApiEndpoint[] = []
        let hasGitHub = false
        const gitlabHosts = new Set<string>()
        for (const [forge, forgeHost] of rows) {
          if (forge === "github") {
            hasGitHub = true
            continue
          }
          if (forge === "gitlab" && typeof forgeHost === "string") {
            const host = normalizeHost(forgeHost)
            if (host !== "") {
              gitlabHosts.add(host)
            }
          }
        }
        if (hasGitHub) {
          endpoints.push(GITHUB_API_ENDPOINT)
        }
        for (const host of [...gitlabHosts].sort()) {
          endpoints.push({
            forge: "gitlab",
            host,
            // Public metadata; succeeds without a token once TLS is trusted.
            path: "/api/v4/version",
          })
        }
        return endpoints
      } catch {
        // Pre-identity schema: non-empty repository table implies GitHub only.
        const count = db
          .query(`SELECT COUNT(*) AS count FROM repository`)
          .values()[0]?.[0]
        const hasRows =
          (typeof count === "number" && count > 0) ||
          (typeof count === "bigint" && count > 0n)
        return hasRows ? [GITHUB_API_ENDPOINT] : []
      }
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
