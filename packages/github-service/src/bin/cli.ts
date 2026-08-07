import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, Layer, Schema } from "effect"
import {
  GitHubRepositoryUnavailableError,
  type GitHubThrottledError,
  isGitHubThrottledError,
} from "../lib/errors.js"
import {
  GITHUB_HELPER_THROTTLED_EXIT_CODE,
  githubHelperSuccess,
  githubHelperThrottled,
  serializeGitHubHelperControl,
} from "../lib/github-helper-protocol.js"
import type { GitHubService } from "../lib/github-service.js"
import { makeGitHubServiceLive } from "../lib/github-service-live.js"

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

export const githubRepository = (
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

export const runGitHubCli = <A, E>(
  program: Effect.Effect<A, E, GitHubService>,
): void => {
  let observedThrottle: GitHubThrottledError | undefined
  const observeThrottle = (throttle: GitHubThrottledError): void => {
    if (
      observedThrottle === undefined ||
      throttle.retryAt > observedThrottle.retryAt
    ) {
      observedThrottle = throttle
    }
  }
  const githubServiceCliLive = makeGitHubServiceLive(observeThrottle).pipe(
    Layer.provide(BunFileSystem.layer),
  )
  const writeControl = (control: ReturnType<typeof githubHelperSuccess>) =>
    process.stderr.write(`${serializeGitHubHelperControl(control)}\n`)
  const writeThrottle = (throttle: GitHubThrottledError) =>
    process.stderr.write(
      `${serializeGitHubHelperControl(githubHelperThrottled(throttle))}\n`,
    )

  program.pipe(
    Effect.provide(githubServiceCliLive),
    Effect.tap(() =>
      Effect.sync(() =>
        writeControl(
          observedThrottle === undefined
            ? githubHelperSuccess()
            : githubHelperSuccess({ throttle: observedThrottle }),
        ),
      ),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error instanceof GitHubRepositoryUnavailableError) {
          process.exitCode = 2
          return
        }
        if (isGitHubThrottledError(error)) {
          writeThrottle(error)
          process.exitCode = GITHUB_HELPER_THROTTLED_EXIT_CODE
          return
        }
        if (error instanceof CliArgumentError) {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 1
          return
        }
        // Child stderr crosses the Keymaxxer credential boundary. Errors from
        // remote APIs or Effect defects can contain arbitrary request data, so
        // keep the user-facing failure deliberately non-diagnostic here.
        process.stderr.write("GitHub helper command failed\n")
        process.exitCode = 1
      }),
    ),
    BunRuntime.runMain,
  )
}
