const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== ""

export type SessionWorktreeParts = {
  sessionId: string | null
  worktreePath: string | null
}

export const sessionWorktreeParts = (
  sessionId: string | null | undefined,
  worktreePath: string | null | undefined,
): SessionWorktreeParts => ({
  sessionId: present(sessionId) ? sessionId : null,
  worktreePath: present(worktreePath) ? worktreePath : null,
})
