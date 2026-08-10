import { tmpdir } from "node:os"

const sanitizeSegment = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "repo"
}

export const repositorySlug = (projectPath: string): string =>
  projectPath.split("/").map(sanitizeSegment).join("-")

/**
 * Stable, collision-resistant branch for one Work Item.
 * Encodes repository slug, GitHub issue number, and Work Item id.
 */
export const workItemBranchName = (input: {
  readonly projectPath: string
  readonly issueNumber: number
  readonly workItemId: string
}): string => {
  const slug = repositorySlug(input.projectPath)
  return `rfa/${slug}/${input.issueNumber}/${input.workItemId}`
}

const basename = (path: string): string => {
  const normalized = path.replace(/[/\\]+$/, "")
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] ?? normalized
}

const dirname = (path: string): string => {
  const normalized = path.replace(/[/\\]+$/, "")
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  )
  if (index < 0) {
    return "."
  }
  return index === 0 ? "/" : normalized.slice(0, index)
}

const repositoryStem = (localPath: string): string => {
  const base = basename(localPath)
  if (base === ".bare") {
    return basename(dirname(localPath))
  }
  return base.endsWith(".git") ? base.slice(0, -4) || "repo" : base
}

/**
 * Parent directory that will hold Issue Worktrees for a Repository.
 *
 * - bare + `.bare` layout: project root (sibling of `.bare`)
 * - other bare: sibling `{stem}-worktrees` next to the bare store
 * - non-bare: under TMPDIR so the main working tree is never polluted
 */
export const worktreeParentPath = (input: {
  readonly localPath: string
  readonly isBare: boolean
  readonly projectPath: string
  readonly tmpDir?: string
}): string => {
  const localPath = input.localPath.replace(/[/\\]+$/, "")

  if (input.isBare) {
    if (basename(localPath) === ".bare") {
      return dirname(localPath)
    }
    return `${dirname(localPath)}/${repositoryStem(localPath)}-worktrees`
  }

  const temporaryDirectory = (input.tmpDir ?? tmpdir())
    .trim()
    .replace(/[/\\]+$/, "")
  const path = input.projectPath.split("/").map(sanitizeSegment).join("/")
  return `${temporaryDirectory}/ready-for-agent/${path}`
}

export const workItemDirectoryName = (input: {
  readonly issueNumber: number
  readonly workItemId: string
}): string => `${input.issueNumber}-${input.workItemId}`

/**
 * Absolute worktree path for one Work Item.
 */
export const workItemWorktreePath = (input: {
  readonly localPath: string
  readonly isBare: boolean
  readonly projectPath: string
  readonly issueNumber: number
  readonly workItemId: string
  readonly tmpDir?: string
}): string => {
  const parent = worktreeParentPath(input)
  const name = workItemDirectoryName({
    issueNumber: input.issueNumber,
    workItemId: input.workItemId,
  })
  return `${parent}/${name}`
}
