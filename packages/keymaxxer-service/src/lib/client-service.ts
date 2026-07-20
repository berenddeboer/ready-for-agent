import { Effect } from "effect"
import {
  type AddSecretInput,
  type FindSecretInput,
  type KeymaxxerError,
  type RunWithSecretsInput,
  type SecretMetadata,
  decodeAddSecretInput,
  decodeRunWithSecretsInput,
  decodeRunWithSecretsResult,
  decodeSecretMetadataList,
  decodeSecretName,
  keymaxxerError,
} from "./models.js"
import type { KeymaxxerServiceShape } from "./service.js"

export type ToolResult = {
  readonly content?: unknown
  readonly isError?: boolean
  readonly structuredContent?: unknown
}

export type KeymaxxerToolClient = {
  readonly callTool: (input: {
    readonly arguments: Record<string, unknown>
    readonly name: string
  }) => Promise<ToolResult>
  readonly close: () => Promise<void>
}

export type ParsedToolResult = {
  readonly isError: boolean
  readonly structuredContent: unknown
  readonly text: string
}

export const toolResultText = (result: {
  readonly content?: unknown
}): string =>
  Array.isArray(result.content)
    ? result.content
        .map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
            ? item.text
            : "",
        )
        .join("\n")
    : ""

export type ClientServiceDeps = {
  /** Promise only at the MCP SDK connect boundary. */
  readonly createClient: () => Promise<KeymaxxerToolClient>
  readonly failureMessage: (operation: string) => string
  readonly initialize?: Effect.Effect<void, KeymaxxerError>
}

/**
 * Shared Effect-native KeymaxxerService over an MCP tool client.
 * `tryPromise` is confined to MCP SDK connect/callTool; domain work uses Effect.gen / Effect.fn.
 */
export const makeKeymaxxerClientService = (
  deps: ClientServiceDeps,
): {
  readonly service: KeymaxxerServiceShape
  readonly close: Effect.Effect<void>
} => {
  let clientPromise: Promise<KeymaxxerToolClient> | null = null
  let secretsCache: readonly SecretMetadata[] | null = null
  let secretsInFlight: Effect.Effect<
    readonly SecretMetadata[],
    KeymaxxerError
  > | null = null

  const resetClient = (): Effect.Effect<void> =>
    Effect.promise(async () => {
      const failed = clientPromise
      clientPromise = null
      secretsCache = null
      secretsInFlight = null
      if (failed === null) return
      await failed.then((client) => client.close()).catch(() => undefined)
    })

  const getClient = (): Effect.Effect<KeymaxxerToolClient, KeymaxxerError> =>
    Effect.tryPromise({
      try: () => {
        clientPromise ??= deps.createClient()
        return clientPromise
      },
      catch: () => keymaxxerError("connect", deps.failureMessage("connect")),
    }).pipe(Effect.tapError(() => resetClient()))

  const callTool = Effect.fn("KeymaxxerService.callTool")(function* (
    operation: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    const client = yield* getClient()
    const result = yield* Effect.tryPromise({
      try: () => client.callTool({ name, arguments: args }),
      catch: () => keymaxxerError(operation, deps.failureMessage(operation)),
    }).pipe(Effect.tapError(() => resetClient()))

    return {
      isError: result.isError === true,
      structuredContent: result.structuredContent,
      text: toolResultText(result),
    } satisfies ParsedToolResult
  })

  const loadSecrets = (): Effect.Effect<
    readonly SecretMetadata[],
    KeymaxxerError
  > =>
    callTool("listSecrets", "keymaxxer_list", {}).pipe(
      Effect.flatMap((result) =>
        result.isError
          ? Effect.fail(keymaxxerError("listSecrets", "Keymaxxer list failed"))
          : decodeSecretMetadataList("listSecrets", result.text),
      ),
    )

  const listSecrets = (
    refresh = false,
  ): Effect.Effect<readonly SecretMetadata[], KeymaxxerError> => {
    if (!refresh && secretsCache !== null) {
      return Effect.succeed(secretsCache)
    }

    if (!refresh && secretsInFlight !== null) {
      return secretsInFlight
    }

    const inFlight = loadSecrets().pipe(
      Effect.tap((secrets) =>
        Effect.sync(() => {
          secretsCache = secrets
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          secretsCache = null
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (secretsInFlight === inFlight) secretsInFlight = null
        }),
      ),
    )
    secretsInFlight = inFlight
    return inFlight
  }

  const findSecretNames = Effect.fn("KeymaxxerService.findSecretNames")(
    function* (
      inputs: readonly {
        readonly provider: string
        readonly account: string
      }[],
    ) {
      const secrets = yield* listSecrets(true)
      const names: Array<string | null> = []
      for (const input of inputs) {
        const matches = secrets.filter(
          (secret) =>
            secret.provider?.toLowerCase() === input.provider.toLowerCase() &&
            secret.account?.toLowerCase() === input.account.toLowerCase(),
        )
        if (matches.length > 1) {
          return yield* keymaxxerError(
            "findSecrets",
            "Multiple Keymaxxer secrets match provider and account",
          )
        }
        names.push(matches[0]?.name ?? null)
      }
      return names
    },
  )

  const initialize =
    deps.initialize ??
    listSecrets().pipe(
      Effect.asVoid,
      Effect.withSpan("KeymaxxerService.initialize"),
    )

  const hasSecret = Effect.fn("KeymaxxerService.hasSecret")(function* (
    name: string,
  ) {
    yield* decodeSecretName("hasSecret", name)
    const hasName = (secrets: readonly SecretMetadata[]) =>
      secrets.some((secret) => secret.name === name)
    if (hasName(yield* listSecrets())) return true
    return hasName(yield* listSecrets(true))
  })

  const findSecret = Effect.fn("KeymaxxerService.findSecret")(function* (
    input: FindSecretInput,
  ) {
    const [found] = yield* findSecretNames([input])
    return found ?? null
  })

  const findSecrets = Effect.fn("KeymaxxerService.findSecrets")(function* (
    inputs: readonly FindSecretInput[],
  ) {
    return yield* findSecretNames(inputs)
  })

  const addSecret = Effect.fn("KeymaxxerService.addSecret")(function* (
    input: AddSecretInput,
  ) {
    const decoded = yield* decodeAddSecretInput(input)
    const result = yield* callTool("addSecret", "keymaxxer_add", {
      ...decoded,
    })
    if (result.text.toLowerCase().includes("cancelled")) return false
    if (result.isError) {
      return yield* keymaxxerError("addSecret", "Keymaxxer add failed")
    }
    yield* listSecrets(true)
    return true
  })

  const runWithSecrets = Effect.fn("KeymaxxerService.runWithSecrets")(
    function* (input: RunWithSecretsInput) {
      const decoded = yield* decodeRunWithSecretsInput(input)
      const result = yield* callTool("runWithSecrets", "keymaxxer_run", {
        command: decoded.command,
        cwd: decoded.cwd,
        secrets: [...decoded.secrets],
        timeoutMs: decoded.timeoutMs,
      })
      return yield* decodeRunWithSecretsResult(
        result.structuredContent,
        result.text,
      )
    },
  )

  const service: KeymaxxerServiceShape = {
    initialize,
    hasSecret,
    findSecret,
    findSecrets,
    addSecret,
    runWithSecrets,
  }

  return { service, close: resetClient() }
}
