import { Effect, Layer, Schema } from "effect"
import {
  AddSecretResponse,
  FindSecretResponse,
  HasSecretResponse,
  HealthResponse,
  InitializeResponse,
  KeymaxxerError,
  RunWithSecretsResult,
  containsRawSecretValue,
  validateRunInput,
  validateSecretName,
} from "./models.js"
import { KeymaxxerService, type KeymaxxerServiceShape } from "./service.js"

export type SidecarLayerOptions = {
  readonly fetch?: typeof globalThis.fetch
  readonly retryDelayMs?: number
  readonly startupTimeoutMs?: number
}

export const sidecarKeymaxxerLayer = (
  value: string,
  options: SidecarLayerOptions = {},
): Layer.Layer<KeymaxxerService, KeymaxxerError> =>
  Layer.effect(
    KeymaxxerService,
    Effect.try({
      try: () => makeSidecarService(parseSidecarUrl(value), options),
      catch: () => safeError("configure", "Invalid Keymaxxer sidecar URL"),
    }),
  )

export const parseSidecarUrl = (value: string) => {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw new Error("Sidecar URL must be an HTTP IPv4 loopback origin")
  }
  return url
}

const makeSidecarService = (
  baseUrl: URL,
  options: SidecarLayerOptions,
): KeymaxxerServiceShape => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const retryDelayMs = options.retryDelayMs ?? 100
  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000

  const request = <S extends Schema.ConstraintDecoder<unknown>>(
    operation: string,
    path: string,
    schema: S,
    responseKeys: readonly string[],
    body?: unknown,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImplementation(new URL(path, baseUrl), {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json" },
          method: body === undefined ? "GET" : "POST",
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        return (await response.json()) as unknown
      },
      catch: () => safeError(operation, "Keymaxxer sidecar request failed"),
    }).pipe(
      Effect.flatMap((json) =>
        containsRawSecretValue(json) || !hasExactKeys(json, responseKeys)
          ? Effect.fail(
              safeError(operation, "Keymaxxer sidecar request failed"),
            )
          : Schema.decodeUnknownEffect(schema)(json).pipe(
              Effect.mapError(() =>
                safeError(operation, "Keymaxxer sidecar request failed"),
              ),
            ),
      ),
    )

  const waitForHealth = (): Effect.Effect<void, KeymaxxerError> => {
    const startedAt = Date.now()
    const connect = (): Effect.Effect<Response, KeymaxxerError> =>
      Effect.tryPromise({
        try: () => {
          const remainingMs = Math.max(
            1,
            startupTimeoutMs - (Date.now() - startedAt),
          )
          return fetchImplementation(new URL("/health", baseUrl), {
            signal: AbortSignal.timeout(remainingMs),
          })
        },
        catch: () =>
          safeError("initialize", "Keymaxxer sidecar request failed"),
      }).pipe(
        Effect.catchIf(
          () => true,
          (error) =>
            Date.now() - startedAt >= startupTimeoutMs
              ? Effect.fail(error)
              : Effect.sleep(`${retryDelayMs} millis`).pipe(
                  Effect.flatMap(connect),
                ),
        ),
      )

    return connect().pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () => {
            if (!response.ok) throw new Error("Health request failed")
            return (await response.json()) as unknown
          },
          catch: () =>
            safeError("initialize", "Keymaxxer sidecar request failed"),
        }),
      ),
      Effect.flatMap((json) =>
        !hasExactKeys(json, ["status", "protocolVersion"])
          ? Effect.fail(
              safeError("initialize", "Keymaxxer sidecar request failed"),
            )
          : Schema.decodeUnknownEffect(HealthResponse)(json).pipe(
              Effect.mapError(() =>
                safeError("initialize", "Keymaxxer sidecar request failed"),
              ),
            ),
      ),
      Effect.asVoid,
    )
  }

  return {
    initialize: waitForHealth().pipe(
      Effect.flatMap(() =>
        request(
          "initialize",
          "/initialize",
          InitializeResponse,
          ["initialized"],
          {},
        ),
      ),
      Effect.asVoid,
    ),
    hasSecret: (name) =>
      validateSecretName(name)
        ? request(
            "hasSecret",
            "/has-secret",
            HasSecretResponse,
            ["hasSecret"],
            { name },
          ).pipe(Effect.map((result) => result.hasSecret))
        : Effect.fail(safeError("hasSecret", "Invalid secret name")),
    findSecret: (input) =>
      request(
        "findSecret",
        "/find-secret",
        FindSecretResponse,
        ["name"],
        input,
      ).pipe(Effect.map((result) => result.name)),
    addSecret: (input) =>
      validateSecretName(input.name)
        ? request(
            "addSecret",
            "/add-secret",
            AddSecretResponse,
            ["added"],
            input,
          ).pipe(Effect.map((result) => result.added))
        : Effect.fail(safeError("addSecret", "Invalid secret name")),
    runWithSecrets: (input) =>
      validateRunInput(input)
        ? request(
            "runWithSecrets",
            "/run-with-secrets",
            RunWithSecretsResult,
            ["exitCode", "stdout", "stderr"],
            input,
          )
        : Effect.fail(safeError("runWithSecrets", "Invalid command input")),
  }
}

const safeError = (operation: string, message: string) =>
  new KeymaxxerError({ operation, message })

const hasExactKeys = (value: unknown, keys: readonly string[]) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key))
