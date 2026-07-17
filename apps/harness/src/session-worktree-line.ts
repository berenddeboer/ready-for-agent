const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== ""

export const sessionWorktreeLine = (
  sessionId: string | null | undefined,
  worktreePath: string | null | undefined,
): string | null => {
  const hasSession = present(sessionId)
  const hasPath = present(worktreePath)
  if (hasSession && hasPath) {
    return `${sessionId} / ${worktreePath}`
  }
  if (hasSession) {
    return sessionId
  }
  if (hasPath) {
    return worktreePath
  }
  return null
}
