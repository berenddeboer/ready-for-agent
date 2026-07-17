import { Context, Effect, Layer } from "effect"
import type {
  AddSecretInput,
  FindSecretInput,
  RunWithSecretsInput,
  RunWithSecretsResult,
  SecretName,
} from "./models.js"
import { KeymaxxerError } from "./models.js"

export interface KeymaxxerServiceShape {
  readonly enabled?: boolean
  readonly initialize: Effect.Effect<void, KeymaxxerError>
  readonly hasSecret: (
    name: SecretName,
  ) => Effect.Effect<boolean, KeymaxxerError>
  readonly findSecret: (
    input: FindSecretInput,
  ) => Effect.Effect<SecretName | null, KeymaxxerError>
  readonly findSecrets: (
    inputs: readonly FindSecretInput[],
  ) => Effect.Effect<readonly (SecretName | null)[], KeymaxxerError>
  readonly addSecret: (
    input: AddSecretInput,
  ) => Effect.Effect<boolean, KeymaxxerError>
  readonly removeSecret: (
    name: SecretName,
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
      findSecret: () => Effect.succeed(null),
      findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
      addSecret: (input: AddSecretInput) =>
        Effect.sync(() => {
          secrets.add(input.name)
          return true
        }),
      removeSecret: (name: SecretName) =>
        Effect.sync(() => secrets.delete(name)),
      runWithSecrets: () =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    }
  })

export const disabledKeymaxxerLayer: Layer.Layer<KeymaxxerService> =
  Layer.succeed(KeymaxxerService, {
    enabled: false,
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(false),
    findSecret: () => Effect.succeed(null),
    findSecrets: (inputs) => Effect.succeed(inputs.map(() => null)),
    addSecret: () => Effect.succeed(false),
    removeSecret: () => Effect.succeed(false),
    runWithSecrets: (input) =>
      Effect.tryPromise({
        try: async () => {
          const child = Bun.spawn(["bash", "-c", input.command], {
            cwd: input.cwd,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
            timeout: input.timeoutMs,
          })
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          return { exitCode, stdout, stderr }
        },
        catch: () =>
          new KeymaxxerError({
            operation: "run command",
            message: "Failed to run command without Keymaxxer",
          }),
      }),
  })
