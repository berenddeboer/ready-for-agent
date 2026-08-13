/**
 * Interactive continuation argv for a captured Agent Backend.
 * Distinct from headless Agent Turn argument builders.
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
        arguments: [input.workingDirectory, "--session", input.sessionId],
      }
    case "grok":
      return {
        executableName: "grok",
        arguments: [
          "--cwd",
          input.workingDirectory,
          "--resume",
          input.sessionId,
        ],
      }
    case "codex":
      return {
        executableName: "codex",
        arguments: ["resume", "-C", input.workingDirectory, input.sessionId],
      }
    case "claude":
      return {
        executableName: "claude",
        arguments: ["--resume", input.sessionId],
      }
    default:
      return null
  }
}
