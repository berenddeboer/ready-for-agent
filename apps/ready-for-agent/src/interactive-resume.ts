/**
 * Interactive continuation argv for a captured Agent Backend.
 * Distinct from headless Agent Turn argument builders.
 *
 * Permission bypass is launch-scoped argv only: it does not write user,
 * Repository, Harness Config, or Agent Backend configuration.
 */
export type InteractiveResumeCommand = {
  readonly executableName: string
  readonly arguments: readonly string[]
}

export const interactiveResumeCommand = (input: {
  readonly backendId: string
  readonly sessionId: string
  readonly workingDirectory: string
}): InteractiveResumeCommand | null => {
  switch (input.backendId) {
    case "opencode":
      return {
        executableName: "opencode",
        arguments: [
          input.workingDirectory,
          "--session",
          input.sessionId,
          "--auto",
        ],
      }
    case "grok":
      return {
        executableName: "grok",
        arguments: [
          "--cwd",
          input.workingDirectory,
          "--resume",
          input.sessionId,
          "--permission-mode",
          "bypassPermissions",
        ],
      }
    case "codex":
      return {
        executableName: "codex",
        arguments: [
          "resume",
          "--dangerously-bypass-approvals-and-sandbox",
          "-C",
          input.workingDirectory,
          input.sessionId,
        ],
      }
    case "claude":
      return {
        executableName: "claude",
        arguments: [
          "--resume",
          input.sessionId,
          "--dangerously-skip-permissions",
        ],
      }
    default:
      return null
  }
}
