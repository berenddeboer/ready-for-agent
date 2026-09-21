import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Schema } from "effect"
import { formatUserFacingError } from "@ready-for-agent/forge-contract"
import type { LinearService } from "../lib/linear-service.js"
import { LinearServiceLive } from "../lib/linear-service-live.js"

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

export const writeStandardOutput = (value: string): Effect.Effect<void> =>
  Effect.sync(() => process.stdout.write(value))

export const runLinearCli = <A, E>(
  program: Effect.Effect<A, E, LinearService>,
): void =>
  program.pipe(
    Effect.provide(LinearServiceLive),
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(
          `${formatUserFacingError(error, "Command failed")}\n`,
        )
        process.exitCode = 1
      }),
    ),
    BunRuntime.runMain,
  )
