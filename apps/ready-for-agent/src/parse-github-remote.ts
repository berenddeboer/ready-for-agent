import { Option } from "effect"

export type GitHubRemote = {
  readonly owner: string
  readonly repo: string
}

const githubRemotePatterns = [
  // git@github.com:owner/repo.git
  // git@github.com-work:owner/repo.git (SSH host alias)
  /^git@[^:]*(?:github\.com)[^:]*:([^/]+)\/(.+?)(?:\.git)?\/?$/,
  // https://github.com/owner/repo.git
  // https://user:token@github.com/owner/repo.git
  // https://www.github.com/owner/repo
  /^https?:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  // ssh://git@github.com/owner/repo.git
  // ssh://git@github.com-work/owner/repo.git
  /^ssh:\/\/[^/]*(?:github\.com)[^/]*\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  // git://github.com/owner/repo.git
  /^git:\/\/(?:www\.)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
] as const

export const parseGitHubRemote = (url: string): Option.Option<GitHubRemote> => {
  const trimmed = url.trim()
  for (const pattern of githubRemotePatterns) {
    const match = pattern.exec(trimmed)
    if (match?.[1] && match[2]) {
      return Option.some({
        owner: match[1],
        repo: match[2].replace(/\.git$/, ""),
      })
    }
  }
  return Option.none()
}
