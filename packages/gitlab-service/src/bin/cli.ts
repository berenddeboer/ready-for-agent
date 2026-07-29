import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Schema } from "effect"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import { GitLabProjectUnavailableError } from "../lib/errors.js"
import type { GitLabService } from "../lib/gitlab-service.js"
import { GitLabServiceLive } from "../lib/gitlab-service-live.js"

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

export const gitlabRepository = (
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

export const runGitLabCli = <A, E>(
  program: Effect.Effect<A, E, GitLabService>,
): void =>
  program.pipe(
    Effect.provide(GitLabServiceLive),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error instanceof GitLabProjectUnavailableError) {
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
