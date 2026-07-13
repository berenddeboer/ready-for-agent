import { Context, Effect, Layer } from "effect"
import type {
  AddSecretInput,
  KeymaxxerError,
  RunWithSecretsInput,
  RunWithSecretsResult,
  SecretName,
} from "./models.js"

export interface KeymaxxerServiceShape {
  readonly initialize: Effect.Effect<void, KeymaxxerError>
  readonly hasSecret: (
    name: SecretName,
  ) => Effect.Effect<boolean, KeymaxxerError>
  readonly addSecret: (
    input: AddSecretInput,
  ) => Effect.Effect<boolean, KeymaxxerError>
  readonly runWithSecrets: (
    input: RunWithSecretsInput,
  ) => Effect.Effect<RunWithSecretsResult, KeymaxxerError>
}

export class KeymaxxerService extends Context.Service<
  KeymaxxerService,
  KeymaxxerServiceShape
>()("@ready-for-agent/keymaxxer-service/KeymaxxerService") {}

export const testKeymaxxerLayer = (
  secretNames: readonly string[] = [],
): Layer.Layer<KeymaxxerService> =>
  Layer.sync(KeymaxxerService, () => {
    const secrets = new Set(secretNames)

    return {
      initialize: Effect.void,
      hasSecret: (name: SecretName) => Effect.succeed(secrets.has(name)),
      addSecret: (input: AddSecretInput) =>
        Effect.sync(() => {
          secrets.add(input.name)
          return true
        }),
      runWithSecrets: () =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    }
  })
