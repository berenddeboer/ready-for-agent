import { tmpdir } from "node:os"

const processTempRoot = (tmpDir?: string): string =>
  (tmpDir ?? tmpdir()).trim().replace(/[/\\]+$/, "")

/**
 * Harness-owned directory for Work Item PR screenshots.
 * Under the process OS temp root, never the target worktree.
 */
export const workItemAttachmentDirectory = (input: {
  readonly workItemId: string
  readonly tmpDir?: string
}): string =>
  `${processTempRoot(input.tmpDir)}/ready-for-agent/pr-attachments/${input.workItemId}`
