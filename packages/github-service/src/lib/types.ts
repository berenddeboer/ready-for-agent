import type { ForgeRepository } from "@ready-for-agent/forge-contract"

export type GitHubRepository = ForgeRepository

export const GITHUB_CI_GATE_KIND = "workflow"

/** Local file the harness uploads as a GitHub user attachment. */
export interface UploadUserAttachmentInput {
  readonly name: string
  readonly contentType: string
  readonly filePath: string
}

const USER_ATTACHMENT_PATH_PREFIX = "/user-attachments/assets/"

/** True when `value` is a GitHub user-attachment CDN URL. */
export const isGitHubUserAttachmentUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(USER_ATTACHMENT_PATH_PREFIX) &&
      url.pathname.length > USER_ATTACHMENT_PATH_PREFIX.length
    )
  } catch {
    return false
  }
}
