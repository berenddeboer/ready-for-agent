import { Schema } from "effect"

export const SecretName = Schema.String
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
export type AddSecretInput = typeof AddSecretInput.Type

export const HasSecretInput = Schema.Struct({ name: SecretName })
export type HasSecretInput = typeof HasSecretInput.Type

export const FindSecretInput = Schema.Struct({
  provider: Schema.String,
  account: Schema.String,
})
export type FindSecretInput = typeof FindSecretInput.Type

export const RunWithSecretsInput = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  secrets: Schema.Array(SecretName),
  timeoutMs: Schema.Finite,
})
export type RunWithSecretsInput = typeof RunWithSecretsInput.Type

export const RunWithSecretsResult = Schema.Struct({
  exitCode: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
})
export type RunWithSecretsResult = typeof RunWithSecretsResult.Type

export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  protocolVersion: Schema.Literal(2),
})

export const InitializeResponse = Schema.Struct({
  initialized: Schema.Literal(true),
})
export const HasSecretResponse = Schema.Struct({ hasSecret: Schema.Boolean })
export const FindSecretResponse = Schema.Struct({
  name: Schema.NullOr(SecretName),
})
export const AddSecretResponse = Schema.Struct({ added: Schema.Boolean })

export const protocolVersion = 2 as const

export class KeymaxxerError extends Schema.TaggedErrorClass<KeymaxxerError>()(
  "KeymaxxerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const secretNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

export const validateSecretName = (name: string) => secretNamePattern.test(name)

export const validateRunInput = (input: RunWithSecretsInput) =>
  input.command.trim() !== "" &&
  input.cwd.startsWith("/") &&
  input.secrets.length > 0 &&
  input.secrets.every(validateSecretName) &&
  new Set(input.secrets).size === input.secrets.length &&
  Number.isInteger(input.timeoutMs) &&
  input.timeoutMs > 0

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
