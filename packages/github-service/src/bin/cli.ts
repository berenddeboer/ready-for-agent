import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Schema } from "effect"
import {
  GitHubRepositoryUnavailableError,
  type GitHubService,
  GitHubServiceLive,
  formatUserFacingError,
} from "../index.js"

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

export const runGitHubCli = <A, E>(
  program: Effect.Effect<A, E, GitHubService>,
): void =>
  program.pipe(
    Effect.provide(GitHubServiceLive),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error instanceof GitHubRepositoryUnavailableError) {
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
