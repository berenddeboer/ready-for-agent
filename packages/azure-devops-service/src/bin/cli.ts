import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Schema } from "effect"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import type { AzureDevOpsService } from "../lib/azure-devops-service.js"
import { AzureDevOpsServiceLive } from "../lib/azure-devops-service-live.js"
import { AzureDevOpsProjectUnavailableError } from "../lib/errors.js"

export class CliArgumentError extends Schema.TaggedErrorClass<CliArgumentError>()(
  "CliArgumentError",
  { message: Schema.String },
) {}

export const decodeArgument = (
  value: string | undefined,
  name: string,
): Effect.Effect<string, CliArgumentError> =>
  value === undefined
    ? Effect.fail(new CliArgumentError({ message: `Missing ${name} argument` }))
    : Effect.succeed(Buffer.from(value, "base64url").toString("utf8"))

export const azureDevOpsRepository = (
  forge: string,
  forgeHost: string,
  projectPath: string,
) => ({
  forge,
  forgeHost,
  projectPath,
})

export const writeStandardOutput = (value: string): Effect.Effect<void> =>
  Effect.sync(() => process.stdout.write(value))

export const runAzureDevOpsCli = <A, E>(
  program: Effect.Effect<A, E, AzureDevOpsService>,
): void =>
  program.pipe(
    Effect.provide(AzureDevOpsServiceLive),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error instanceof AzureDevOpsProjectUnavailableError) {
          process.exitCode = 2
          return
        }
        process.stderr.write(
          `${formatUserFacingError(error, "Command failed")}\n`,
        )
        process.exitCode = 1
      }),
    ),
    BunRuntime.runMain,
  )
