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

/**
 * Percent-encoding is decoded exactly once here, at the URL boundary:
 * `URL.pathname` preserves it, and Forge API/clone URL builders re-encode
 * each Project Path segment, so keeping escapes would double-encode names
 * containing e.g. spaces (`%2520`). Malformed escapes stay as-is.
 */
const decodePercentEncoding = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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
    return { host, path: decodePercentEncoding(url.pathname) }
  } catch {
    return undefined
  }
}

/** Canonical Azure DevOps Forge Host both clone URL spellings resolve to. */
const AZURE_DEVOPS_CANONICAL_HOST = "dev.azure.com"
const AZURE_DEVOPS_SSH_HOST = "ssh.dev.azure.com"
const AZURE_DEVOPS_VS_SSH_HOST = "vs-ssh.visualstudio.com"
const VISUALSTUDIO_HOST_SUFFIX = ".visualstudio.com"

const pathSegments = (rawPath: string): string[] =>
  rawPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/\.git$/i, ""))

/**
 * Match an Azure DevOps org/project/repository identity from a clone
 * remote's host and path. Handles the canonical `dev.azure.com` host (HTTPS
 * `/{org}/{project}/_git/{repo}` and the `ssh.dev.azure.com` SCP form
 * `v3/{org}/{project}/{repo}`), the legacy per-org `*.visualstudio.com`
 * HTTPS hosts (`/{project}/_git/{repo}`, optionally under
 * `/DefaultCollection/`), and the legacy `vs-ssh.visualstudio.com` SSH host
 * (`v3/{org}/{project}/{repo}` — unlike the HTTPS form, the org comes from
 * the path, not the hostname).
 * Always resolves to the canonical `dev.azure.com` Forge Host so both
 * spellings share one Repository identity — the ADO analogue of preferring
 * GitLab's canonical `web_url` host over the SSH/remote guess. The `repo`
 * segment (a project can contain multiple, differently-named Git
 * repositories) is captured here rather than discarded, since it's not
 * always the same string as `project`.
 */
const parseAzureDevOpsRemote = (
  hostNoPort: string,
  rawPath: string,
):
  | { readonly org: string; readonly project: string; readonly repo: string }
  | undefined => {
  if (
    hostNoPort === AZURE_DEVOPS_SSH_HOST ||
    hostNoPort === AZURE_DEVOPS_VS_SSH_HOST
  ) {
    const segments = pathSegments(rawPath)
    const [v3, org, project, repo] = segments
    if (
      segments.length >= 4 &&
      v3?.toLowerCase() === "v3" &&
      org !== undefined &&
      project !== undefined &&
      repo !== undefined
    ) {
      return { org, project, repo }
    }
    return undefined
  }
  if (hostNoPort === AZURE_DEVOPS_CANONICAL_HOST) {
    const segments = pathSegments(rawPath)
    const [org, project, gitSegment, repo] = segments
    if (
      segments.length >= 4 &&
      org !== undefined &&
      project !== undefined &&
      gitSegment?.toLowerCase() === "_git" &&
      repo !== undefined
    ) {
      return { org, project, repo }
    }
    return undefined
  }
  if (hostNoPort.endsWith(VISUALSTUDIO_HOST_SUFFIX)) {
    const org = hostNoPort.slice(0, -VISUALSTUDIO_HOST_SUFFIX.length)
    if (org.length === 0) return undefined
    const segments = pathSegments(rawPath)
    const withoutCollection =
      segments[0]?.toLowerCase() === "defaultcollection"
        ? segments.slice(1)
        : segments
    const [project, gitSegment, repo] = withoutCollection
    if (
      withoutCollection.length >= 3 &&
      project !== undefined &&
      gitSegment?.toLowerCase() === "_git" &&
      repo !== undefined
    ) {
      return { org, project, repo }
    }
    return undefined
  }
  return undefined
}

/**
 * Guess Forge identity from a clone remote. GitHub spellings retain the
 * canonical github.com identity; `dev.azure.com` / `*.visualstudio.com`
 * spellings resolve to Azure DevOps; every other network git host is a
 * GitLab guess. The SSH/remote host is not authoritative for GitLab Forge
 * Host — import verifies against the Forge API and persists the instance's
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
  const hostNoPort = forgeHost.split(":")[0] ?? forgeHost

  const azureDevOps = parseAzureDevOpsRemote(hostNoPort, parsed.path)
  if (azureDevOps !== undefined) {
    // Fold the repo segment into Project Path only when it differs from the
    // project name, keeping the common case's two-segment spelling
    // unchanged (see AzureDevOpsRepository.projectPath doc).
    const projectPath =
      azureDevOps.repo === azureDevOps.project
        ? `${azureDevOps.org}/${azureDevOps.project}`
        : `${azureDevOps.org}/${azureDevOps.project}/${azureDevOps.repo}`
    return Option.some({
      forge: "azure-devops",
      forgeHost: AZURE_DEVOPS_CANONICAL_HOST,
      projectPath,
    })
  }

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
