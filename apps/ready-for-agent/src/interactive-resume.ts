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

const pinnedModel = (agentModel: string | null | undefined): string | null => {
  if (agentModel === undefined || agentModel === null) {
    return null
  }
  const trimmed = agentModel.trim()
  return trimmed.length === 0 ? null : trimmed
}

const pinnedThinkingLevel = (
  thinkingLevel: string | null | undefined,
): string | null => {
  if (thinkingLevel === undefined || thinkingLevel === null) {
    return null
  }
  const trimmed = thinkingLevel.trim()
  return trimmed.length === 0 ? null : trimmed
}

export const interactiveResumeCommand = (input: {
  readonly backendId: string
  readonly sessionId: string
  readonly workingDirectory: string
  readonly agentModel?: string | null
  readonly thinkingLevel?: string | null
}): InteractiveResumeCommand | null => {
  const agentModel = pinnedModel(input.agentModel)
  const thinkingLevel = pinnedThinkingLevel(input.thinkingLevel)
  switch (input.backendId) {
    case "opencode":
      return {
        executableName: "opencode",
        arguments: [
          input.workingDirectory,
          "--session",
          input.sessionId,
          "--auto",
          ...(agentModel === null ? [] : (["-m", agentModel] as const)),
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
          ...(agentModel === null ? [] : (["-m", agentModel] as const)),
          ...(thinkingLevel === null
            ? []
            : (["--reasoning-effort", thinkingLevel] as const)),
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
          ...(agentModel === null ? [] : (["-m", agentModel] as const)),
          ...(thinkingLevel === null
            ? []
            : (["-c", `model_reasoning_effort=${thinkingLevel}`] as const)),
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
          ...(agentModel === null ? [] : (["--model", agentModel] as const)),
          ...(thinkingLevel === null
            ? []
            : (["--effort", thinkingLevel] as const)),
        ],
      }
    default:
      return null
  }
}
