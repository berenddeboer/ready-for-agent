import { Effect, Schema } from "effect"
import {
  AddSecretInput,
  AddSecretResponse,
  FindSecretInput,
  FindSecretResponse,
  HasSecretInput,
  HasSecretResponse,
  InitializeResponse,
  KeymaxxerError,
  RunWithSecretsInput,
  RunWithSecretsResult,
  protocolVersion,
  validateRunInput,
  validateSecretName,
} from "./models.js"
import type { KeymaxxerServiceShape } from "./service.js"

type RunEffect = <A>(effect: Effect.Effect<A, KeymaxxerError>) => Promise<A>

export const createKeymaxxerSidecarFetch = (
  keymaxxer: KeymaxxerServiceShape,
  runEffect: RunEffect = Effect.runPromise,
): ((request: Request) => Promise<Response>) => {
  let initializePromise: Promise<void> | null = null

  const initialize = () => {
    initializePromise ??= runEffect(keymaxxer.initialize).catch((error) => {
      initializePromise = null
      throw error
    })
    return initializePromise
  }

  return async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", protocolVersion })
    }
    if (request.method !== "POST") return notFound()
    if (request.headers.has("origin")) {
      return new Response("browser requests are forbidden", { status: 403 })
    }
    if (!isJsonRequest(request)) {
      return new Response("application/json required", { status: 415 })
    }

    try {
      switch (url.pathname) {
        case "/initialize":
          assertExactKeys(await requestBody(request), [])
          await initialize()
          return schemaResponse(InitializeResponse, {
            initialized: true,
          } as const)
        case "/has-secret": {
          const input = decodeRequest(
            HasSecretInput,
            await requestBody(request),
            ["name"],
          )
          if (!validateSecretName(input.name)) return invalidInput()
          return schemaResponse(HasSecretResponse, {
            hasSecret: await runEffect(keymaxxer.hasSecret(input.name)),
          })
        }
        case "/find-secret": {
          const input = decodeRequest(
            FindSecretInput,
            await requestBody(request),
            ["provider", "account"],
          )
          return schemaResponse(FindSecretResponse, {
            name: await runEffect(keymaxxer.findSecret(input)),
          })
        }
        case "/add-secret": {
          const keys = [
            "name",
            "provider",
            "account",
            "environment",
            "access",
            "description",
            "tags",
          ]
          const input = decodeRequest(
            AddSecretInput,
            await requestBody(request),
            keys,
          )
          if (!validateSecretName(input.name)) return invalidInput()
          return schemaResponse(AddSecretResponse, {
            added: await runEffect(keymaxxer.addSecret(input)),
          })
        }
        case "/run-with-secrets": {
          const input = decodeRequest(
            RunWithSecretsInput,
            await requestBody(request),
            ["command", "cwd", "secrets", "timeoutMs"],
          )
          if (!validateRunInput(input)) return invalidInput()
          const result = await runEffect(keymaxxer.runWithSecrets(input))
          return schemaResponse(RunWithSecretsResult, result)
        }
        default:
          return notFound()
      }
    } catch (error) {
      if (error instanceof InvalidRequestError) return invalidInput()
      const operation =
        error instanceof KeymaxxerError ? error.operation : "sidecar"
      return Response.json(
        new KeymaxxerError({
          operation,
          message: "Keymaxxer operation failed",
        }),
        { status: 500 },
      )
    }
  }
}

class InvalidRequestError extends Error {}

const requestBody = async (request: Request): Promise<unknown> => {
  try {
    return (await request.json()) as unknown
  } catch {
    throw new InvalidRequestError()
  }
}

const decodeRequest = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  keys: readonly string[],
): S["Type"] => {
  assertExactKeys(value, keys)
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw new InvalidRequestError()
  }
}

const assertExactKeys = (value: unknown, allowedKeys: readonly string[]) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError()
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new InvalidRequestError()
  }
}

const schemaResponse = <S extends Schema.ConstraintEncoder<unknown, never>>(
  schema: S,
  value: S["Type"],
) => Response.json(Schema.encodeSync(schema)(value))

const invalidInput = () =>
  Response.json({ error: "invalid request" }, { status: 400 })

const notFound = () => new Response("not found", { status: 404 })

const isJsonRequest = (request: Request) =>
  request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json"
