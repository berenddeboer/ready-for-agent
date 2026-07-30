import { Option } from "effect"
import { parseGitHubRemote } from "./parse-github-remote.js"
import type { ForgeRemote } from "./types.js"

const normalizeProjectPath = (value: string): string =>
  value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")

const parseScpRemote = (
  value: string,
): { readonly host: string; readonly path: string } | undefined => {
  if (value.includes("://")) return undefined
  const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { host: match[1], path: match[2] }
}

const parseUrlRemote = (
  value: string,
): { readonly host: string; readonly path: string } | undefined => {
  try {
    const url = new URL(value)
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
      return undefined
    }
    // HTTP(S) non-default ports belong in the Forge Host guess so verify can
    // reach self-hosted GitLab on e.g. :8443. SSH/git ports are transport-only
    // and must not be treated as the API host port.
    const includePort =
      (url.protocol === "http:" || url.protocol === "https:") && url.port !== ""
    const host = includePort ? `${url.hostname}:${url.port}` : url.hostname
    return { host, path: url.pathname }
  } catch {
    return undefined
  }
}

/**
 * Guess Forge identity from a clone remote. GitHub spellings retain the
 * canonical github.com identity; every other network git host is a GitLab
 * guess. The SSH/remote host is not authoritative for GitLab Forge Host —
 * import verifies against the Forge API and persists the instance's
 * canonical API/web host (e.g. git.drupal.org SSH → git.drupalcode.org).
 */
export const parseForgeRemote = (
  remoteUrl: string,
): Option.Option<ForgeRemote> => {
  const value = remoteUrl.trim()
  const github = parseGitHubRemote(value)
  if (Option.isSome(github)) {
    return Option.some({
      forge: "github",
      forgeHost: "github.com",
      projectPath: `${github.value.owner}/${github.value.repo}`,
    })
  }

  const parsed = parseScpRemote(value) ?? parseUrlRemote(value)
  if (parsed === undefined) return Option.none()
  const forgeHost = parsed.host.toLowerCase().replace(/^www\./, "")
  const projectPath = normalizeProjectPath(parsed.path)
  if (
    forgeHost.length === 0 ||
    !projectPath.includes("/") ||
    projectPath.split("/").some((segment) => segment.length === 0)
  ) {
    return Option.none()
  }
  return Option.some({ forge: "gitlab", forgeHost, projectPath })
}
