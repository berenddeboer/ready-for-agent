import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"
import {
  KeymaxxerService,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import {
  FIXTURE_GITHUB_REPOSITORY,
  FIXTURE_GITHUB_SECRET_NAME,
  FIXTURE_GITLAB_FORGE_HOST,
  FIXTURE_GITLAB_PROJECT_PATH,
  FIXTURE_GITLAB_SECRET_NAME,
  FIXTURE_GITLAB_VAULT_ACCOUNT,
} from "./constants.ts"

export type FixtureForge = "github" | "gitlab"

export type FixtureCloneSpec = {
  readonly forge: FixtureForge
  readonly secretName: string
  readonly provider: "github" | "gitlab"
  readonly account: string
  readonly displayRepository: string
  readonly cloneUrlTemplate: (secretName: string) => string
}

class CloneFixtureError extends Data.TaggedError("CloneFixtureError")<{
  readonly message: string
}> {}

const supportDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(supportDir, "../../../..")
const fixtureVaultDir = resolve(workspaceRoot, "e2e/fixtures/keymaxxer")

export const githubFixtureSpec = (): FixtureCloneSpec => ({
  forge: "github",
  secretName: FIXTURE_GITHUB_SECRET_NAME,
  provider: "github",
  account: FIXTURE_GITHUB_REPOSITORY,
  displayRepository: FIXTURE_GITHUB_REPOSITORY,
  cloneUrlTemplate: (secretName) =>
    `https://x-access-token:\${${secretName}}@github.com/${FIXTURE_GITHUB_REPOSITORY}.git`,
})

export const gitlabFixtureSpec = (): FixtureCloneSpec => ({
  forge: "gitlab",
  secretName: FIXTURE_GITLAB_SECRET_NAME,
  provider: "gitlab",
  account: FIXTURE_GITLAB_VAULT_ACCOUNT,
  displayRepository: FIXTURE_GITLAB_PROJECT_PATH,
  // GitLab HTTPS clones authenticate as oauth2:<token> (see Create PR push).
  cloneUrlTemplate: (secretName) =>
    `https://oauth2:\${${secretName}}@${FIXTURE_GITLAB_FORGE_HOST}/${FIXTURE_GITLAB_PROJECT_PATH}.git`,
})

const missingCredentialMessage = (spec: FixtureCloneSpec) => {
  const regenHint =
    spec.forge === "gitlab"
      ? "Regenerate with: ./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab (see docs/e2e-fixture.md)."
      : "Regenerate with: ./scripts/regenerate-e2e-keymaxxer-vault.sh (see docs/e2e-fixture.md)."
  return [
    `Live e2e requires a Keymaxxer credential for account ${spec.account}`,
    `(canonical name ${spec.secretName}, provider=${spec.provider}).`,
    "Add that secret to your vault, or set E2E_KEYMAXXER_MASTER_KEY / KEYMAXXER_MASTER_KEY",
    "to use the checked-in fixture vault.",
    regenHint,
  ].join(" ")
}

const keymaxxerBin = () => {
  const workspaceBin = resolve(workspaceRoot, "node_modules/.bin/keymaxxer")
  if (existsSync(workspaceBin)) return workspaceBin
  const which = Bun.which("keymaxxer")
  if (which) return which
  throw new Error(
    "keymaxxer@0.2.1 is not installed. Run bun install from the workspace root.",
  )
}

const fixtureVaultEnv = (): NodeJS.ProcessEnv | null => {
  const masterKey =
    process.env.E2E_KEYMAXXER_MASTER_KEY?.trim() ||
    process.env.KEYMAXXER_MASTER_KEY?.trim()
  const useFixture =
    process.env.CI === "true" ||
    process.env.E2E_USE_FIXTURE_VAULT === "1" ||
    Boolean(masterKey)

  if (!useFixture) return null
  if (!masterKey) {
    throw new Error(
      "CI live e2e requires E2E_KEYMAXXER_MASTER_KEY (or KEYMAXXER_MASTER_KEY).",
    )
  }

  const home = mkdtempSync(join(tmpdir(), "rfa-e2e-keymaxxer-home-"))
  const keymaxxerDir = join(home, ".keymaxxer")
  mkdirSync(keymaxxerDir, { recursive: true })
  copyFileSync(
    join(fixtureVaultDir, "vault.db"),
    join(keymaxxerDir, "vault.db"),
  )
  copyFileSync(
    join(fixtureVaultDir, "vault.meta.json"),
    join(keymaxxerDir, "vault.meta.json"),
  )

  return {
    ...process.env,
    HOME: home,
    KEYMAXXER_MASTER_KEY: masterKey,
    KEYMAXXER_APPROVE: "deny",
  }
}

const listKeymaxxerOutput = (env: NodeJS.ProcessEnv): string => {
  const listed = spawnSync(keymaxxerBin(), ["list"], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (listed.status !== 0) {
    throw new Error(
      [
        "Failed to list Keymaxxer secrets before cloning a fixture Repository.",
        listed.stderr?.trim() ||
          listed.stdout?.trim() ||
          "keymaxxer list failed",
      ].join("\n"),
    )
  }
  return `${listed.stdout}\n${listed.stderr}`
}

/**
 * Whether the fixture vault (or ambient vault when not in fixture mode)
 * currently lists the given e2e credential. Used to soft-skip the GitLab
 * scenario until the operator regenerates the dual-secret vault.
 *
 * Infrastructure failures (missing master key, keymaxxer list errors) throw;
 * only a successful list that lacks the secret returns false.
 */
export const hasFixtureCredential = (
  spec: FixtureCloneSpec = gitlabFixtureSpec(),
): boolean => {
  let fixtureHome: string | undefined
  try {
    const fixtureEnv = fixtureVaultEnv()
    if (fixtureEnv?.HOME) {
      fixtureHome = fixtureEnv.HOME
    }
    const env = fixtureEnv ?? process.env
    const output = listKeymaxxerOutput(env)
    return output.includes(spec.secretName) || output.includes(spec.account)
  } finally {
    if (fixtureHome) {
      rmSync(fixtureHome, { recursive: true, force: true })
    }
  }
}

const assertSecretPresentViaCli = (
  env: NodeJS.ProcessEnv,
  spec: FixtureCloneSpec,
) => {
  const output = listKeymaxxerOutput(env)
  if (!output.includes(spec.secretName) && !output.includes(spec.account)) {
    throw new Error(missingCredentialMessage(spec))
  }
}

export const keymaxxerRunArgs = (
  secretName: string,
  command: string,
): string[] => ["run", "--secrets", secretName, "--", command]

const cloneViaCli = (
  checkoutParent: string,
  env: NodeJS.ProcessEnv,
  spec: FixtureCloneSpec,
) => {
  assertSecretPresentViaCli(env, spec)
  const dest = join(checkoutParent, "repo")
  const cloneCommand = [
    "git",
    "clone",
    "--depth",
    "1",
    `"${spec.cloneUrlTemplate(spec.secretName)}"`,
    `"${dest}"`,
  ].join(" ")

  const result = spawnSync(
    keymaxxerBin(),
    keymaxxerRunArgs(spec.secretName, cloneCommand),
    {
      env,
      encoding: "utf8",
      timeout: 180_000,
    },
  )

  if (result.status !== 0 || !existsSync(join(dest, ".git"))) {
    const detail =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `keymaxxer run exited with code ${result.status ?? "unknown"}`
    if (
      detail.toLowerCase().includes("not found") ||
      detail.toLowerCase().includes("unknown secret") ||
      detail.toLowerCase().includes("no such secret")
    ) {
      throw new Error(`${missingCredentialMessage(spec)}\n${detail}`)
    }
    throw new Error(
      `Failed to clone ${spec.displayRepository} through Keymaxxer.\n${detail}`,
    )
  }
  return dest
}

const cloneViaSidecar = async (
  checkoutParent: string,
  sidecarUrl: string,
  spec: FixtureCloneSpec,
) => {
  const dest = join(checkoutParent, "repo")

  const program = Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    yield* keymaxxer.initialize
    const secretName = yield* keymaxxer.findSecret({
      provider: spec.provider,
      account: spec.account,
    })
    if (secretName === null) {
      return yield* new CloneFixtureError({
        message: missingCredentialMessage(spec),
      })
    }
    const cloneCommand = [
      "git",
      "clone",
      "--depth",
      "1",
      `"${spec.cloneUrlTemplate(secretName)}"`,
      `"${dest}"`,
    ].join(" ")
    const result = yield* keymaxxer.runWithSecrets({
      command: cloneCommand,
      cwd: checkoutParent,
      secrets: [secretName],
      timeoutMs: 180_000,
    })
    if (result.exitCode !== 0 || !existsSync(join(dest, ".git"))) {
      return yield* new CloneFixtureError({
        message: [
          `Failed to clone ${spec.displayRepository} through Keymaxxer Sidecar.`,
          result.stderr.trim() ||
            result.stdout.trim() ||
            `exit ${result.exitCode}`,
        ].join("\n"),
      })
    }
    return dest
  })

  return Effect.runPromise(
    program.pipe(Effect.provide(sidecarKeymaxxerLayer(sidecarUrl))),
  )
}

/**
 * Clone an End-to-End Fixture Repository through Keymaxxer into a fresh
 * temporary checkout. Leaves ~/.keymaxxer untouched in local mode.
 */
export const cloneFixtureRepository = async (
  forge: FixtureForge = "github",
): Promise<{
  readonly checkoutPath: string
  readonly cleanup: () => void
  readonly spec: FixtureCloneSpec
}> => {
  const spec = forge === "gitlab" ? gitlabFixtureSpec() : githubFixtureSpec()
  const checkoutParent = mkdtempSync(
    join(tmpdir(), `rfa-e2e-${forge}-fixture-checkout-`),
  )
  let fixtureVaultHome: string | undefined
  const cleanup = () => {
    rmSync(checkoutParent, { recursive: true, force: true })
    if (fixtureVaultHome) {
      rmSync(fixtureVaultHome, { recursive: true, force: true })
      fixtureVaultHome = undefined
    }
  }

  try {
    const fixtureEnv = fixtureVaultEnv()
    if (fixtureEnv !== null) {
      if (fixtureEnv.HOME) {
        fixtureVaultHome = fixtureEnv.HOME
      }
      const checkoutPath = cloneViaCli(checkoutParent, fixtureEnv, spec)
      return { checkoutPath, cleanup, spec }
    }

    const sidecarUrl = process.env.KEYMAXXER_SIDECAR_URL?.trim()
    if (sidecarUrl) {
      const checkoutPath = await cloneViaSidecar(
        checkoutParent,
        sidecarUrl,
        spec,
      )
      return { checkoutPath, cleanup, spec }
    }

    const checkoutPath = cloneViaCli(checkoutParent, process.env, spec)
    return { checkoutPath, cleanup, spec }
  } catch (error) {
    cleanup()
    throw error
  }
}
