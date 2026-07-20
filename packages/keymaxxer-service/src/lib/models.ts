import { Effect, Schema } from "effect"

export const SecretName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.brand("SecretName"),
)
export type SecretName = typeof SecretName.Type

export const AddSecretInput = Schema.Struct({
  name: SecretName,
  provider: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  access: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.String),
})
export type AddSecretInput = {
  readonly name: string
  readonly provider?: string
  readonly account?: string
  readonly environment?: string
  readonly access?: string
  readonly description?: string
  readonly tags?: string
}

export const HasSecretInput = Schema.Struct({ name: SecretName })
export type HasSecretInput = { readonly name: string }

export const FindSecretInput = Schema.Struct({
  provider: Schema.String,
  account: Schema.String,
})
export type FindSecretInput = typeof FindSecretInput.Type

export const FindSecretsInput = Schema.Struct({
  secrets: Schema.Array(FindSecretInput),
})
export type FindSecretsInput = typeof FindSecretsInput.Type

export const RunWithSecretsInput = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  secrets: Schema.Array(SecretName),
  timeoutMs: Schema.Finite,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (input: {
        readonly command: string
        readonly cwd: string
        readonly secrets: readonly string[]
        readonly timeoutMs: number
      }) => {
        if (input.command.trim() === "") return false
        if (!input.cwd.startsWith("/")) return false
        if (input.secrets.length === 0) return false
        if (new Set(input.secrets).size !== input.secrets.length) return false
        if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)
          return false
        return true
      },
      {
        title: "RunWithSecretsInput",
        description:
          "non-empty command, absolute cwd, unique secrets, positive timeout",
      },
    ),
  ),
)
export type RunWithSecretsInput = {
  readonly command: string
  readonly cwd: string
  readonly secrets: readonly string[]
  readonly timeoutMs: number
}

export const RunWithSecretsResult = Schema.Struct({
  exitCode: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
})
export type RunWithSecretsResult = typeof RunWithSecretsResult.Type

export const SecretMetadata = Schema.Struct({
  name: Schema.String,
  provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
  account: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type SecretMetadata = {
  readonly name: string
  readonly provider: string | null
  readonly account: string | null
}

export const SecretMetadataList = Schema.Array(SecretMetadata)

export const protocolVersion = 3 as const

export class KeymaxxerError extends Schema.TaggedErrorClass<KeymaxxerError>()(
  "KeymaxxerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export const keymaxxerError = (operation: string, message: string) =>
  new KeymaxxerError({ operation, message })

export const decodeSecretName = (
  operation: string,
  name: string,
): Effect.Effect<SecretName, KeymaxxerError> =>
  Schema.decodeUnknownEffect(SecretName)(name).pipe(
    Effect.mapError(() => keymaxxerError(operation, "Invalid secret name")),
  )

export const decodeAddSecretInput = (
  input: AddSecretInput,
): Effect.Effect<typeof AddSecretInput.Type, KeymaxxerError> =>
  Schema.decodeUnknownEffect(AddSecretInput)(input).pipe(
    Effect.mapError(() => keymaxxerError("addSecret", "Invalid secret name")),
  )

export const decodeRunWithSecretsInput = (
  input: RunWithSecretsInput,
): Effect.Effect<typeof RunWithSecretsInput.Type, KeymaxxerError> =>
  Schema.decodeUnknownEffect(RunWithSecretsInput)(input).pipe(
    Effect.mapError(() =>
      keymaxxerError("runWithSecrets", "Invalid command input"),
    ),
  )

export const decodeSecretMetadataList = (
  operation: string,
  text: string,
): Effect.Effect<readonly SecretMetadata[], KeymaxxerError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => keymaxxerError(operation, "Keymaxxer list failed"),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(SecretMetadataList)(parsed).pipe(
        Effect.mapError(() =>
          keymaxxerError(operation, "Keymaxxer list failed"),
        ),
      ),
    ),
    Effect.map((items) =>
      items.map((item) => ({
        name: item.name,
        provider: item.provider ?? null,
        account: item.account ?? null,
      })),
    ),
  )

export const decodeRunWithSecretsResult = (
  structuredContent: unknown,
  text: string,
): Effect.Effect<RunWithSecretsResult, KeymaxxerError> => {
  const fromStructured =
    Schema.decodeUnknownOption(RunWithSecretsResult)(structuredContent)
  if (fromStructured._tag === "Some") {
    return Effect.succeed(fromStructured.value)
  }

  const fromText = parseRunResultText(text)
  if (fromText !== null) {
    return Effect.succeed(fromText)
  }

  return Effect.fail(
    keymaxxerError(
      "runWithSecrets",
      "Keymaxxer returned an invalid command result",
    ),
  )
}

const parseRunResultText = (text: string): RunWithSecretsResult | null => {
  const exitCode = text.match(/^exit_code: (-?\d+)$/m)
  const stdoutMarker = "--- stdout ---\n"
  const stderrMarker = "\n--- stderr ---\n"
  const stdoutStart = text.indexOf(stdoutMarker)
  const stderrStart = text.indexOf(
    stderrMarker,
    stdoutStart + stdoutMarker.length,
  )
  const repeatedMarker = text.indexOf(stderrMarker, stderrStart + 1)
  if (!exitCode || stdoutStart < 0 || stderrStart < stdoutStart) return null
  if (repeatedMarker >= 0) return null

  return {
    exitCode: Number.parseInt(exitCode[1] ?? "", 10),
    stdout: text.slice(stdoutStart + stdoutMarker.length, stderrStart),
    stderr: text.slice(stderrStart + stderrMarker.length),
  }
}

export const containsRawSecretValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsRawSecretValue)
  }

  if (typeof value !== "object" || value === null) {
    return false
  }

  return Object.entries(value).some(
    ([key, child]) =>
      ["secret", "secretValue", "value"].includes(key) ||
      containsRawSecretValue(child),
  )
}
