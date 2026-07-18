import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "../src/index.js"
import {
  InstallDependenciesFallbackError,
  InvalidWorktreeContextError,
  WorktreeContextMissingError,
  installDependencies,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (worktreePath: string | null): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 79,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  startingCommitOid: null,
  sessionId: null,
})

const stubOpencode = (impl: {
  readonly start?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
  }) => Effect.Effect<{ sessionId: string }, never>
}) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: (input) =>
        impl.start?.(input) ??
        Effect.succeed({ sessionId: "ses_fallback", assistantText: "" }),
      continue: () =>
        Effect.succeed({ sessionId: "ses_continue", assistantText: "" }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Layer.Layer.Success<typeof PlatformLayer> | Opencode
  >,
  opencodeLayer: Layer.Layer<Opencode, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(opencodeLayer), Effect.provide(PlatformLayer)),
  )

const withTemp = async (
  setup: (root: string) => Promise<void>,
  assert: (root: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-install-deps-"))
  try {
    await setup(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Install a fake binary on PATH that records argv and exits 0. */
const installFakeBinary = async (
  binDir: string,
  name: string,
  scriptBody: string,
) => {
  await mkdir(binDir, { recursive: true })
  const path = join(binDir, name)
  await writeFile(path, `#!/usr/bin/env bash\n${scriptBody}\n`)
  await chmod(path, 0o755)
  return path
}

const withPath = <A>(binDir: string, runFn: () => Promise<A>): Promise<A> => {
  const previous = process.env.PATH
  process.env.PATH = `${binDir}:${previous ?? ""}`
  return runFn().finally(() => {
    if (previous === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previous
    }
  })
}

describe("installDependencies", () => {
  it("rejects missing worktree context", async () => {
    const error = await Effect.runPromise(
      installDependencies(baseContext(null)).pipe(
        Effect.flip,
        Effect.provide(stubOpencode({})),
        Effect.provide(PlatformLayer),
      ),
    )
    expect(error).toBeInstanceOf(WorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-missing-worktree-does-not-exist")
    const error = await Effect.runPromise(
      installDependencies(baseContext(missing)).pipe(
        Effect.flip,
        Effect.provide(stubOpencode({})),
        Effect.provide(PlatformLayer),
      ),
    )
    expect(error).toBeInstanceOf(InvalidWorktreeContextError)
  })

  it("runs bun install for a bun project", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lock"), "{}\n")
        const binDir = join(root, "bin")
        await installFakeBinary(
          binDir,
          "bun",
          `echo "$*" > "${join(root, "bun-args.txt")}"\nexit 0`,
        )
      },
      async (root) => {
        const binDir = join(root, "bin")
        await withPath(binDir, () =>
          run(installDependencies(baseContext(root))),
        )
        const args = await Bun.file(join(root, "bun-args.txt")).text()
        expect(args.trim()).toBe("install")
      },
    ))

  it("runs npm install for an npm project", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "package-lock.json"), "{}\n")
        await installFakeBinary(
          join(root, "bin"),
          "npm",
          `echo "$*" > "${join(root, "npm-args.txt")}"\nexit 0`,
        )
      },
      async (root) => {
        await withPath(join(root, "bin"), () =>
          run(installDependencies(baseContext(root))),
        )
        expect((await Bun.file(join(root, "npm-args.txt")).text()).trim()).toBe(
          "install",
        )
      },
    ))

  it("runs pnpm install for a pnpm project", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
        await installFakeBinary(
          join(root, "bin"),
          "pnpm",
          `echo "$*" > "${join(root, "pnpm-args.txt")}"\nexit 0`,
        )
      },
      async (root) => {
        await withPath(join(root, "bin"), () =>
          run(installDependencies(baseContext(root))),
        )
        expect(
          (await Bun.file(join(root, "pnpm-args.txt")).text()).trim(),
        ).toBe("install")
      },
    ))

  it("runs yarn install for a yarn project", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "yarn.lock"), "# yarn\n")
        await installFakeBinary(
          join(root, "bin"),
          "yarn",
          `echo "$*" > "${join(root, "yarn-args.txt")}"\nexit 0`,
        )
      },
      async (root) => {
        await withPath(join(root, "bin"), () =>
          run(installDependencies(baseContext(root))),
        )
        expect(
          (await Bun.file(join(root, "yarn-args.txt")).text()).trim(),
        ).toBe("install")
      },
    ))

  it("runs non-interactive composer install for a Composer project", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "composer.json"), "{}\n")
        await installFakeBinary(
          join(root, "bin"),
          "composer",
          `echo "$*" > "${join(root, "composer-args.txt")}"\nexit 0`,
        )
      },
      async (root) => {
        await withPath(join(root, "bin"), () =>
          run(installDependencies(baseContext(root))),
        )
        expect(
          (await Bun.file(join(root, "composer-args.txt")).text()).trim(),
        ).toBe("install --no-interaction")
      },
    ))

  it("starts OpenCode when no manager is recognizable", () =>
    withTemp(
      async () => {},
      async (root) => {
        let started: {
          prompt: string
          cwd: string
          model: string
          variant: string
        } | null = null
        await run(
          installDependencies(baseContext(root)),
          stubOpencode({
            start: (input) => {
              started = input
              return Effect.succeed({
                sessionId: "ses_ambiguous",
                assistantText: "",
              })
            },
          }),
        )
        expect(started).not.toBeNull()
        expect(started!.cwd).toBe(root)
        expect(started!.model).toBe("opencode/test-model")
        expect(started!.variant).toBe("high")
        expect(started!.prompt).toContain("could not choose")
      },
    ))

  it("starts OpenCode when metadata conflicts", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "yarn@1.22.0" }),
        )
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        let started = false
        await run(
          installDependencies(baseContext(root)),
          stubOpencode({
            start: () => {
              started = true
              return Effect.succeed({
                sessionId: "ses_conflict",
                assistantText: "",
              })
            },
          }),
        )
        expect(started).toBe(true)
      },
    ))

  it("falls back to OpenCode when direct install fails, then succeeds", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lock"), "{}\n")
        await installFakeBinary(
          join(root, "bin"),
          "bun",
          `echo "install exploded" >&2\nexit 7`,
        )
      },
      async (root) => {
        let started: { prompt: string } | null = null
        await withPath(join(root, "bin"), () =>
          run(
            installDependencies(baseContext(root)),
            stubOpencode({
              start: (input) => {
                started = { prompt: input.prompt }
                return Effect.succeed({
                  sessionId: "ses_after_fail",
                  assistantText: "",
                })
              },
            }),
          ),
        )
        expect(started).not.toBeNull()
        expect(started!.prompt).toContain("bun install")
        expect(started!.prompt).toContain("Exit code: 7")
        expect(started!.prompt).toContain("install exploded")
      },
    ))

  it("falls back to OpenCode when the package manager cannot be launched", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "npm@10.0.0" }),
        )
        await mkdir(join(root, "empty-bin"))
      },
      async (root) => {
        let started: { prompt: string } | null = null
        const previous = process.env.PATH
        process.env.PATH = join(root, "empty-bin")
        try {
          await run(
            installDependencies(baseContext(root)),
            stubOpencode({
              start: (input) => {
                started = { prompt: input.prompt }
                return Effect.succeed({
                  sessionId: "ses_missing_manager",
                  assistantText: "",
                })
              },
            }),
          )
        } finally {
          if (previous === undefined) {
            delete process.env.PATH
          } else {
            process.env.PATH = previous
          }
        }

        expect(started).not.toBeNull()
        expect(started!.prompt).toContain("npm install")
        expect(started!.prompt).toContain("Exit code: -1")
      },
    ))

  it("keeps only a bounded stderr tail in fallback diagnostics", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lock"), "{}\n")
        await installFakeBinary(
          join(root, "bin"),
          "bun",
          `printf 'prefix-marker'; printf '%05000d' 0 >&2; printf 'tail-marker' >&2; exit 1`,
        )
      },
      async (root) => {
        let started: { prompt: string } | null = null
        await withPath(join(root, "bin"), () =>
          run(
            installDependencies(baseContext(root)),
            stubOpencode({
              start: (input) => {
                started = { prompt: input.prompt }
                return Effect.succeed({
                  sessionId: "ses_bounded_stderr",
                  assistantText: "",
                })
              },
            }),
          ),
        )
        expect(started).not.toBeNull()
        expect(started!.prompt).toContain("tail-marker")
        expect(started!.prompt.length).toBeLessThan(4_500)
      },
    ))

  it("does not return or require a Session id on successful fallback", () =>
    withTemp(
      async () => {},
      async (root) => {
        const outcome = await run(
          installDependencies(baseContext(root)).pipe(
            Effect.map(() => "void-success" as const),
          ),
          stubOpencode({
            start: () =>
              Effect.succeed({
                sessionId: "ses_must_discard",
                assistantText: "",
              }),
          }),
        )
        // Handler returns void; Session id is never part of the success value.
        expect(outcome).toBe("void-success")
      },
    ))
})

describe("installDependencies fallback failure", () => {
  it("maps OpenCode exit into InstallDependenciesFallbackError", async () => {
    const { OpencodeExitError } = await import("@ready-for-agent/opencode")
    const root = await mkdtemp(join(tmpdir(), "rfa-install-fallback-fail-"))
    try {
      const error = await Effect.runPromise(
        installDependencies(baseContext(root)).pipe(
          Effect.flip,
          Effect.provide(
            Layer.succeed(
              Opencode,
              Opencode.of({
                start: () =>
                  Effect.fail(
                    new OpencodeExitError({ exitCode: 2, cwd: root }),
                  ),
                continue: () =>
                  Effect.succeed({ sessionId: "unused", assistantText: "" }),
                listModels: () => Effect.succeed([]),
              }),
            ),
          ),
          Effect.provide(PlatformLayer),
        ),
      )
      expect(error).toBeInstanceOf(InstallDependenciesFallbackError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
