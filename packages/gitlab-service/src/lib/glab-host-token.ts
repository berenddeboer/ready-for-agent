import { Duration, Effect, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"

/**
 * Prefer this over `glab config get token --host`, which can exit successfully
 * with a fallback token for hosts that were never authenticated.
 *
 * `glab auth status --hostname <host> --show-token` is host-specific. Exit code
 * alone is not enough: glab can exit non-zero when the Forge API is unreachable
 * even though a local token for that host is present. Parse the unmasked
 * Token found line instead (exit code is ignored).
 *
 * Line shapes (glab versions differ):
 * - `Token found: <token>` (glab through ~1.110)
 * - `Token found in <source>: <token>` (glab main, e.g. keyring / config file)
 */
export const GLAB_HOST_TOKEN_TIMEOUT = Duration.seconds(60)

/**
 * Matches both historical and current glab show-token lines. Captures the last
 * colon-separated unmasked token on the line.
 */
const TOKEN_FOUND_LINE = /Token found(?:\s+in\s+[^:\n]+)?:\s+(\S+)/g

/** Extract an unmasked token from `glab auth status --show-token` output. */
export const parseGlabAuthStatusShowToken = (
  combinedOutput: string,
): string | null => {
  const matches = combinedOutput.matchAll(TOKEN_FOUND_LINE)
  let found: string | null = null
  for (const match of matches) {
    const token = match[1]
    if (token === undefined || token === "") continue
    // Without --show-token glab prints asterisks; reject masked values.
    if (token.includes("*")) continue
    found = token
  }
  return found
}

export type ResolveGlabHostTokenOptions = {
  readonly forgeHost: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly cwd?: string
  readonly timeout?: Duration.Duration
}

/**
 * Resolve a host-scoped glab token, or null when the host is not authenticated
 * (or the CLI is unavailable / times out).
 */
export const resolveGlabHostToken = (
  options: ResolveGlabHostTokenOptions,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? GLAB_HOST_TOKEN_TIMEOUT
    const command = ChildProcess.make(
      "glab",
      ["auth", "status", "--hostname", options.forgeHost, "--show-token"],
      {
        cwd: options.cwd,
        stdin: "ignore",
      },
    )
    const combined = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* options.spawner.spawn(command)
        const [, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        return `${stdout}\n${stderr}`
      }),
    ).pipe(
      Effect.timeout(timeout),
      Effect.orElseSucceed(() => ""),
    )
    return parseGlabAuthStatusShowToken(combined)
  })
