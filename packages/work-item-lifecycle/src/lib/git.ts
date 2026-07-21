import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GitCommandError } from "./create-worktree-errors.js"

export type GitRepository = {
  readonly localPath: string
  readonly isBare: boolean
}

const repositoryPrefix = (repository: GitRepository): readonly string[] => [
  "-C",
  repository.localPath,
]

export const runGit = (
  repository: GitRepository,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fullArgs = [...repositoryPrefix(repository), ...args]
    const command = ChildProcess.make("git", fullArgs, {
      stdin: "ignore",
    })

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        }
      }),
    )

    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.trim()
      return yield* new GitCommandError({
        message:
          diagnostic === ""
            ? `git ${args.join(" ")} failed with exit ${result.exitCode}`
            : `git ${args.join(" ")} failed with exit ${result.exitCode}: ${diagnostic}`,
        command: "git",
        args: fullArgs,
        cwd: repository.localPath,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
      })
    }

    return result.stdout
  })

export const gitExitCode = (
  repository: GitRepository,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fullArgs = [...repositoryPrefix(repository), ...args]
    const code = yield* spawner.exitCode(
      ChildProcess.make("git", fullArgs, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    return Number(code)
  })
