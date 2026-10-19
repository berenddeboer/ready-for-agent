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
  /**
   * OpenCode V2 session model switch. Run with the same executable, in the
   * resume working directory, before the TUI. Absent when there is no pin.
   * `invalid` means a pin was requested but is not a V2 model reference.
   */
  readonly modelPin?:
    | { readonly kind: "ready"; readonly arguments: readonly string[] }
    | { readonly kind: "invalid" }
}

type OpenCodeModelRef = {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/**
 * V2 `POST /api/session/{sessionID}/model` argv. Matches the headless
 * session-model switch: the root TUI accepts neither `-m` nor `--model`.
 */
export const openCodeModelPinArguments = (input: {
  readonly sessionId: string
  readonly workingDirectory: string
  readonly agentModel: string
  readonly thinkingLevel: string | null
}): readonly string[] | undefined => {
  const reference = splitOpenCodeModelReference(
    input.agentModel,
    input.thinkingLevel,
  )
  if (reference === undefined || input.sessionId.trim() === "") {
    return undefined
  }
  return [
    "api",
    "--header",
    `x-opencode-directory:${encodeURIComponent(input.workingDirectory)}`,
    "post",
    `/api/session/${input.sessionId}/model`,
    "--data",
    JSON.stringify({ model: reference }),
  ]
}

const splitOpenCodeModelReference = (
  model: string,
  thinkingLevel: string | null,
): OpenCodeModelRef | undefined => {
  const hash = model.indexOf("#")
  const base = hash === -1 ? model : model.slice(0, hash)
  const reference =
    thinkingLevel === null || thinkingLevel.length === 0
      ? base
      : `${base}#${thinkingLevel}`
  const providerEnd = reference.indexOf("/")
  if (providerEnd <= 0) {
    return undefined
  }
  const providerID = reference.slice(0, providerEnd)
  const variantStart = reference.indexOf("#", providerEnd + 1)
  const id = reference.slice(
    providerEnd + 1,
    variantStart === -1 ? undefined : variantStart,
  )
  const variant =
    variantStart === -1 ? undefined : reference.slice(variantStart + 1)
  if (
    id.length === 0 ||
    providerID.includes("#") ||
    (variant !== undefined && (variant.length === 0 || variant.includes("#")))
  ) {
    return undefined
  }
  return variant === undefined
    ? { providerID, id }
    : { providerID, id, variant }
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
    case "opencode": {
      const modelPin =
        agentModel === null
          ? undefined
          : openCodeModelPinArguments({
              sessionId: input.sessionId,
              workingDirectory: input.workingDirectory,
              agentModel,
              thinkingLevel,
            })
      return {
        executableName: "opencode",
        arguments: [
          input.workingDirectory,
          "--session",
          input.sessionId,
          "--auto",
        ],
        ...(agentModel === null
          ? {}
          : {
              modelPin:
                modelPin === undefined
                  ? ({ kind: "invalid" } as const)
                  : ({ kind: "ready", arguments: modelPin } as const),
            }),
      }
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
