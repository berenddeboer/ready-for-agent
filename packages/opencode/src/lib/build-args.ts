import { exceedsPromptArgvLimit } from "@ready-for-agent/agent-backend"

const commandName = (command: string): string =>
  command.startsWith("/") ? command.slice(1) : command

const messageTokens = (prompt: string): ReadonlyArray<string> =>
  prompt
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)

/**
 * Prompts go through stdin when argv cannot carry them faithfully.
 *
 * Non-command prompts lose their structure once tokenized, so any newline sends
 * them to stdin. A single-line prompt past the argv byte limit also goes to
 * stdin: otherwise the spawn fails with an opaque platform error.
 */
export const shouldUsePromptStdin = (input: {
  readonly prompt: string
  readonly command?: string
}): boolean =>
  exceedsPromptArgvLimit(input.prompt) ||
  (input.command === undefined && /\r|\n/.test(input.prompt))

/**
 * V2 model reference. A null Thinking Level omits `#variant` so the model
 * default applies. Persisted model and Thinking Level stay separate; only the
 * CLI reference joins them.
 */
export const openCodeModelReference = (
  model: string,
  thinkingLevel: string | null,
): string => {
  const hash = model.indexOf("#")
  const base = hash === -1 ? model : model.slice(0, hash)
  if (thinkingLevel === null || thinkingLevel.length === 0) {
    return base
  }
  return `${base}#${thinkingLevel}`
}

export type OpenCodeModelRef = {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** Split `provider/model` or `provider/model#variant`. Model ids may contain slashes. */
export const splitOpenCodeModelReference = (
  reference: string,
): OpenCodeModelRef | undefined => {
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

/** Prepend `--server` so a turn uses the same explicit server as telemetry. */
export const withOpenCodeServer = (
  args: ReadonlyArray<string>,
  serverUrl: string | undefined,
): ReadonlyArray<string> =>
  serverUrl === undefined || serverUrl.trim().length === 0
    ? args
    : ["--server", serverUrl, ...args]

export const buildRunArgs = (input: {
  readonly prompt: string
  readonly model: string
  /** Null omits `#variant` so OpenCode uses the model default. */
  readonly thinkingLevel: string | null
  readonly sessionId?: string
}): ReadonlyArray<string> => {
  const args = [
    "run",
    "--auto",
    "--format",
    "json",
    "-m",
    openCodeModelReference(input.model, input.thinkingLevel),
  ]

  if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId)
  }

  if (!shouldUsePromptStdin({ prompt: input.prompt })) {
    const tokens = messageTokens(input.prompt)
    if (tokens.length > 0) {
      args.push("--", ...tokens)
    }
  }
  return args
}

const commandApiBody = (input: {
  readonly command: string
  readonly prompt: string
}): string =>
  JSON.stringify({
    name: commandName(input.command),
    text: input.prompt,
    delivery: "steer",
  })

const directoryHeader = (directory: string): string =>
  `x-opencode-directory:${encodeURIComponent(directory)}`

const resolvedModel = (
  model: string,
  thinkingLevel: string | null,
): OpenCodeModelRef | undefined =>
  splitOpenCodeModelReference(openCodeModelReference(model, thinkingLevel))

const apiPost = (input: {
  readonly directory: string
  readonly path: string
  readonly body: string
}): ReadonlyArray<string> => [
  "api",
  "--header",
  directoryHeader(input.directory),
  "post",
  input.path,
  "--data",
  input.body,
]

/**
 * True when the session-command JSON body cannot be passed as `--data`.
 *
 * `opencode api` does not read a request body from stdin. An oversized `--data`
 * argument fails the spawn with a platform error, so the caller must refuse
 * the turn before starting OpenCode. Argument building itself does not apply
 * this check.
 */
export const commandBodyExceedsArgvLimit = (input: {
  readonly command: string
  readonly prompt: string
}): boolean => exceedsPromptArgvLimit(commandApiBody(input))

/**
 * V2 invokes a configured Agent Command through
 * `POST /api/session/{sessionID}/command`, not a `run` flag. The body carries
 * the command name and the raw argument string so `$ARGUMENTS` and shell
 * blocks stay server-owned.
 */
export const buildCommandApiArgs = (input: {
  readonly sessionId: string
  readonly command: string
  readonly prompt: string
  readonly directory: string
}): ReadonlyArray<string> =>
  apiPost({
    directory: input.directory,
    path: `/api/session/${input.sessionId}/command`,
    body: commandApiBody(input),
  })

export const buildSwitchModelApiArgs = (input: {
  readonly sessionId: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly directory: string
}): ReadonlyArray<string> | undefined => {
  const reference = resolvedModel(input.model, input.thinkingLevel)
  if (reference === undefined) {
    return undefined
  }
  return apiPost({
    directory: input.directory,
    path: `/api/session/${input.sessionId}/model`,
    body: JSON.stringify({ model: reference }),
  })
}

export const buildCreateSessionApiArgs = (input: {
  readonly model: string
  readonly thinkingLevel: string | null
  readonly directory: string
}): ReadonlyArray<string> | undefined => {
  const reference = resolvedModel(input.model, input.thinkingLevel)
  if (reference === undefined) {
    return undefined
  }
  return apiPost({
    directory: input.directory,
    path: "/api/session",
    body: JSON.stringify({
      location: { directory: input.directory },
      model: reference,
    }),
  })
}

export const buildSessionWaitApiArgs = (
  sessionId: string,
): ReadonlyArray<string> => [
  "api",
  "post",
  `/api/experimental/session/${sessionId}/wait`,
]

export const buildSessionExportArgs = (
  sessionId: string,
): ReadonlyArray<string> => ["session", "export", sessionId]

export const buildSessionInterruptApiArgs = (
  sessionId: string,
): ReadonlyArray<string> => [
  "api",
  "post",
  `/api/session/${sessionId}/interrupt`,
]

export const joinOpenCodeMessageArgs = (
  messageArgs: ReadonlyArray<string>,
): string =>
  messageArgs
    .map((token) =>
      token.includes(" ") ? `"${token.replace(/"/g, '\\"')}"` : token,
    )
    .join(" ")
