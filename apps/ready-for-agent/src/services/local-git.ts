import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { LocalRepository } from "../domain.ts"
import { parseGitHubRemote } from "../parse-github-remote.ts"

class PathNotFound extends Schema.TaggedErrorClass<PathNotFound>()(
  "PathNotFound",
  { path: Schema.String },
) {
  override get message() {
    return `Path not found: ${this.path}`
  }
}

class NotADirectory extends Schema.TaggedErrorClass<NotADirectory>()(
  "NotADirectory",
  { path: Schema.String },
) {
  override get message() {
    return `Not a directory: ${this.path}`
  }
}

class NotAGitRepository extends Schema.TaggedErrorClass<NotAGitRepository>()(
  "NotAGitRepository",
  { path: Schema.String },
) {
  override get message() {
    return `Not a git repository: ${this.path}`
  }
}

class NoGitHubRemote extends Schema.TaggedErrorClass<NoGitHubRemote>()(
  "NoGitHubRemote",
  { path: Schema.String },
) {
  override get message() {
    return `No GitHub remote found for: ${this.path}`
  }
}

type LocalGitError =
  | PathNotFound
  | NotADirectory
  | NotAGitRepository
  | NoGitHubRemote
  | PlatformError

export class LocalGit extends Context.Service<
  LocalGit,
  {
    readonly inspect: (
      path: string,
    ) => Effect.Effect<LocalRepository, LocalGitError>
  }
>()("ready-for-agent/LocalGit") {
  static readonly layer = Layer.effect(
    LocalGit,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const gitString = (cwd: string, args: ReadonlyArray<string>) =>
        spawner
          .string(ChildProcess.make("git", args, { cwd }))
          .pipe(Effect.map((output) => output.trim()))

      const gitExitCode = (cwd: string, args: ReadonlyArray<string>) =>
        spawner.exitCode(
          ChildProcess.make("git", args, {
            cwd,
            stdout: "ignore",
            stderr: "ignore",
          }),
        )

      const inspect = Effect.fn("LocalGit.inspect")(function* (
        inputPath: string,
      ) {
        const absolutePath = pathService.resolve(inputPath)
        const exists = yield* fs.exists(absolutePath)
        if (!exists) {
          return yield* new PathNotFound({ path: absolutePath })
        }

        const info = yield* fs.stat(absolutePath)
        if (info.type !== "Directory") {
          return yield* new NotADirectory({ path: absolutePath })
        }

        const localPath = yield* fs.realPath(absolutePath)

        const gitDirCode = yield* gitExitCode(localPath, [
          "rev-parse",
          "--git-dir",
        ])
        if (gitDirCode !== 0) {
          return yield* new NotAGitRepository({ path: localPath })
        }

        const isBareOutput = yield* gitString(localPath, [
          "rev-parse",
          "--is-bare-repository",
        ])
        const isBare = isBareOutput === "true"

        const originExit = yield* gitExitCode(localPath, [
          "remote",
          "get-url",
          "origin",
        ])

        const remoteUrl =
          originExit === 0
            ? yield* gitString(localPath, ["remote", "get-url", "origin"])
            : yield* gitString(localPath, ["remote", "-v"]).pipe(
                Effect.map((output) => {
                  const line = output
                    .split("\n")
                    .map((entry) => entry.trim())
                    .find((entry) => entry.includes("github.com"))
                  if (!line) {
                    return undefined
                  }
                  return line.split(/\s+/)[1]
                }),
              )

        if (!remoteUrl) {
          return yield* new NoGitHubRemote({ path: localPath })
        }

        const github = parseGitHubRemote(remoteUrl)
        if (Option.isNone(github)) {
          return yield* new NoGitHubRemote({ path: localPath })
        }

        return {
          githubOwner: github.value.owner,
          githubRepo: github.value.repo,
          localPath,
          isBare,
          paused: true as const,
        }
      })

      return { inspect }
    }),
  )
}
