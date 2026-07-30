import { spawnSync } from "node:child_process"
import {
  githubFixtureSpec,
  gitlabFixtureSpec,
  keymaxxerRunArgs,
} from "../e2e/support/clone-fixture-repo.ts"
import {
  FIXTURE_GITHUB_REPOSITORY,
  FIXTURE_GITHUB_SECRET_NAME,
  FIXTURE_GITLAB_FORGE_HOST,
  FIXTURE_GITLAB_PROJECT_PATH,
  FIXTURE_GITLAB_SECRET_NAME,
} from "../e2e/support/constants.ts"
import { describe, expect, test } from "bun:test"

const runAsKeymaxxerJoins = (restAfterDashDash: string[]) => {
  const command = restAfterDashDash.join(" ")
  return spawnSync(command, {
    shell: true,
    encoding: "utf8",
  })
}

describe("keymaxxer fixture clone command args", () => {
  test("passes the shell-quoted command as a single post-`--` argument", () => {
    const command =
      'git clone --depth 1 "https://example.invalid/repo.git" "/tmp/dest"'
    const args = keymaxxerRunArgs("FIXTURE_SECRET", command)

    expect(args).toEqual(["run", "--secrets", "FIXTURE_SECRET", "--", command])
    expect(args).not.toContain("bash")
    expect(args).not.toContain("-c")
  })

  test("nested bash -c loses multi-word script arguments after keymaxxer join", () => {
    const script = 'printf "%s\\n" retained-arg'
    const broken = runAsKeymaxxerJoins(["bash", "-c", script])

    expect(broken.status).not.toBe(0)
    expect(broken.stdout).not.toContain("retained-arg")
  })

  test("direct multi-word command retains all arguments after keymaxxer join", () => {
    const command = 'printf "%s\\n" retained-arg'
    const args = keymaxxerRunArgs("FIXTURE_SECRET", command)
    const dashDash = args.indexOf("--")
    const rest = args.slice(dashDash + 1)
    const fixed = runAsKeymaxxerJoins(rest)

    expect(fixed.status).toBe(0)
    expect(fixed.stdout.trim()).toBe("retained-arg")
  })
})

describe("fixture clone specs", () => {
  test("GitHub clone URL injects the canonical secret name", () => {
    const spec = githubFixtureSpec()
    expect(spec.secretName).toBe(FIXTURE_GITHUB_SECRET_NAME)
    expect(spec.account).toBe(FIXTURE_GITHUB_REPOSITORY)
    expect(spec.cloneUrlTemplate(spec.secretName)).toContain(
      `x-access-token:\${${FIXTURE_GITHUB_SECRET_NAME}}@github.com/${FIXTURE_GITHUB_REPOSITORY}.git`,
    )
  })

  test("GitLab clone URL uses oauth2 token auth on the Forge Host", () => {
    const spec = gitlabFixtureSpec()
    expect(spec.secretName).toBe(FIXTURE_GITLAB_SECRET_NAME)
    expect(spec.provider).toBe("gitlab")
    expect(spec.account).toBe(
      `${FIXTURE_GITLAB_FORGE_HOST}/${FIXTURE_GITLAB_PROJECT_PATH}`,
    )
    const url = spec.cloneUrlTemplate(spec.secretName)
    expect(url).toContain(
      `oauth2:\${${FIXTURE_GITLAB_SECRET_NAME}}@${FIXTURE_GITLAB_FORGE_HOST}/`,
    )
    expect(url).toContain(`${FIXTURE_GITLAB_PROJECT_PATH}.git`)
  })
})
