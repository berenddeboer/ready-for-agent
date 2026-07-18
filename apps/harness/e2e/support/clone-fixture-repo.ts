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
import { Effect } from "effect"
import {
  KeymaxxerService,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import { FIXTURE_REPOSITORY, FIXTURE_SECRET_NAME } from "./constants.ts"

const supportDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(supportDir, "../../../..")
const fixtureVaultDir = resolve(workspaceRoot, "e2e/fixtures/keymaxxer")

const missingCredentialMessage = [
  `Live e2e requires a Keymaxxer credential for account ${FIXTURE_REPOSITORY}`,
  `(canonical name ${FIXTURE_SECRET_NAME}, provider=github).`,
  "Add that secret to your vault, or set E2E_KEYMAXXER_MASTER_KEY / KEYMAXXER_MASTER_KEY",
  "to use the checked-in fixture vault.",
].join(" ")

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

const assertSecretPresentViaCli = (env: NodeJS.ProcessEnv) => {
  const listed = spawnSync(keymaxxerBin(), ["list"], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (listed.status !== 0) {
    throw new Error(
      [
        "Failed to list Keymaxxer secrets before cloning the fixture Repository.",
        listed.stderr?.trim() ||
          listed.stdout?.trim() ||
          missingCredentialMessage,
      ].join("\n"),
    )
  }
  const output = `${listed.stdout}\n${listed.stderr}`
  if (
    !output.includes(FIXTURE_SECRET_NAME) &&
    !output.includes(FIXTURE_REPOSITORY)
  ) {
    throw new Error(missingCredentialMessage)
  }
}

export const keymaxxerRunArgs = (
  secretName: string,
  command: string,
): string[] => ["run", "--secrets", secretName, "--", command]

const cloneViaCli = (checkoutParent: string, env: NodeJS.ProcessEnv) => {
  assertSecretPresentViaCli(env)
  const dest = join(checkoutParent, "repo")
  const cloneCommand = [
    "git",
    "clone",
    "--depth",
    "1",
    `"https://x-access-token:\${${FIXTURE_SECRET_NAME}}@github.com/${FIXTURE_REPOSITORY}.git"`,
    `"${dest}"`,
  ].join(" ")

  const result = spawnSync(
    keymaxxerBin(),
    keymaxxerRunArgs(FIXTURE_SECRET_NAME, cloneCommand),
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
      throw new Error(`${missingCredentialMessage}\n${detail}`)
    }
    throw new Error(
      `Failed to clone ${FIXTURE_REPOSITORY} through Keymaxxer.\n${detail}`,
    )
  }
  return dest
}

const cloneViaSidecar = async (checkoutParent: string, sidecarUrl: string) => {
  const dest = join(checkoutParent, "repo")

  const program = Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    yield* keymaxxer.initialize
    const secretName = yield* keymaxxer.findSecret({
      provider: "github",
      account: FIXTURE_REPOSITORY,
    })
    if (secretName === null) {
      return yield* Effect.fail(new Error(missingCredentialMessage))
    }
    const cloneCommand = [
      "git",
      "clone",
      "--depth",
      "1",
      `"https://x-access-token:\${${secretName}}@github.com/${FIXTURE_REPOSITORY}.git"`,
      `"${dest}"`,
    ].join(" ")
    const result = yield* keymaxxer.runWithSecrets({
      command: cloneCommand,
      cwd: checkoutParent,
      secrets: [secretName],
      timeoutMs: 180_000,
    })
    if (result.exitCode !== 0 || !existsSync(join(dest, ".git"))) {
      return yield* Effect.fail(
        new Error(
          [
            `Failed to clone ${FIXTURE_REPOSITORY} through Keymaxxer Sidecar.`,
            result.stderr.trim() ||
              result.stdout.trim() ||
              `exit ${result.exitCode}`,
          ].join("\n"),
        ),
      )
    }
    return dest
  })

  return Effect.runPromise(
    program.pipe(Effect.provide(sidecarKeymaxxerLayer(sidecarUrl))),
  )
}

/**
 * Clone the private End-to-End Fixture Repository through Keymaxxer into a
 * fresh temporary checkout. Leaves ~/.keymaxxer untouched in local mode.
 */
export const cloneFixtureRepository = async (): Promise<{
  readonly checkoutPath: string
  readonly cleanup: () => void
}> => {
  const checkoutParent = mkdtempSync(
    join(tmpdir(), "rfa-e2e-fixture-checkout-"),
  )
  const cleanup = () => {
    rmSync(checkoutParent, { recursive: true, force: true })
  }

  try {
    const fixtureEnv = fixtureVaultEnv()
    if (fixtureEnv !== null) {
      const checkoutPath = cloneViaCli(checkoutParent, fixtureEnv)
      return { checkoutPath, cleanup }
    }

    const sidecarUrl = process.env.KEYMAXXER_SIDECAR_URL?.trim()
    if (sidecarUrl) {
      const checkoutPath = await cloneViaSidecar(checkoutParent, sidecarUrl)
      return { checkoutPath, cleanup }
    }

    const checkoutPath = cloneViaCli(checkoutParent, process.env)
    return { checkoutPath, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
