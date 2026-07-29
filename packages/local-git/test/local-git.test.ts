import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { LocalGit } from "../src/lib/local-git.js"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

describe("LocalGit.inspect", () => {
  let tempRoot = ""

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "local-git-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const runInspect = (path: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const localGit = yield* LocalGit
        return yield* localGit.inspect(path)
      }).pipe(
        Effect.provide(LocalGit.layer),
        Effect.provide(BunServices.layer),
      ),
    )

  const runInspectFail = (path: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const localGit = yield* LocalGit
        return yield* localGit.inspect(path)
      }).pipe(
        Effect.flip,
        Effect.provide(LocalGit.layer),
        Effect.provide(BunServices.layer),
      ),
    )

  test("inspects a non-bare repo with origin remote", async () => {
    const repoDir = join(tempRoot, "repo")
    mkdirSync(repoDir)
    writeFileSync(join(repoDir, "README.md"), "fixture\n")
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
    expect(git(["init"]).status).toBe(0)
    expect(
      git(["remote", "add", "origin", "git@github.com:acme/widgets.git"])
        .status,
    ).toBe(0)

    const inspected = await runInspect(repoDir)
    expect(inspected.forge).toBe("github")
    expect(inspected.forgeHost).toBe("github.com")
    expect(inspected.projectPath).toBe("acme/widgets")
    expect(inspected.isBare).toBe(false)
    expect(inspected.paused).toBe(true)
    expect(inspected.localPath).toContain("repo")
  })

  test("guesses GitLab identity from a nested-project SSH remote", async () => {
    const repoDir = join(tempRoot, "gitlab-repo")
    mkdirSync(repoDir)
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
    expect(git(["init"]).status).toBe(0)
    expect(
      git([
        "remote",
        "add",
        "origin",
        "git@git.drupalcode.org:project/oauth_client.git",
      ]).status,
    ).toBe(0)

    const inspected = await runInspect(repoDir)
    expect(inspected).toMatchObject({
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
      isBare: false,
      paused: true,
    })
  })

  test("keeps an SSH alias as a correctable GitLab Forge Host guess", async () => {
    const repoDir = join(tempRoot, "gitlab-alias")
    mkdirSync(repoDir)
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
    expect(git(["init"]).status).toBe(0)
    expect(
      git(["remote", "add", "origin", "git@git.drupal.org:project/mod.git"])
        .status,
    ).toBe(0)

    const inspected = await runInspect(repoDir)
    expect(inspected).toMatchObject({
      forge: "gitlab",
      forgeHost: "git.drupal.org",
      projectPath: "project/mod",
    })
  })

  test("fails when path does not exist", async () => {
    const error = await runInspectFail(join(tempRoot, "missing"))
    expect(error._tag).toBe("PathNotFound")
  })

  test("fails when directory is not a git repository", async () => {
    const dir = join(tempRoot, "plain")
    mkdirSync(dir)
    const error = await runInspectFail(dir)
    expect(error._tag).toBe("NotAGitRepository")
  })

  test("fails when git repo has no supported Forge remote", async () => {
    const repoDir = join(tempRoot, "no-gh")
    mkdirSync(repoDir)
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
    expect(git(["init"]).status).toBe(0)
    expect(git(["remote", "add", "origin", "../widgets.git"]).status).toBe(0)

    const error = await runInspectFail(repoDir)
    expect(error._tag).toBe("NoForgeRemote")
  })
})
