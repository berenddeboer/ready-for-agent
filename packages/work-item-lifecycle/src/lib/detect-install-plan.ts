import { Effect, FileSystem, Path } from "effect"

export type NodePackageManager = "bun" | "npm" | "pnpm" | "yarn"

export type InstallCommand = {
  readonly command: string
  readonly args: readonly string[]
  readonly packageManager: NodePackageManager | "composer"
}

export type InstallPlan =
  | { readonly _tag: "Direct"; readonly install: InstallCommand }
  | {
      readonly _tag: "Fallback"
      readonly reason: string
    }

const NODE_LOCKFILES: ReadonlyArray<{
  readonly file: string
  readonly manager: NodePackageManager
}> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
]

const installFor = (
  manager: NodePackageManager | "composer",
): InstallCommand => {
  switch (manager) {
    case "bun":
      return { command: "bun", args: ["install"], packageManager: "bun" }
    case "npm":
      return { command: "npm", args: ["install"], packageManager: "npm" }
    case "pnpm":
      return { command: "pnpm", args: ["install"], packageManager: "pnpm" }
    case "yarn":
      return { command: "yarn", args: ["install"], packageManager: "yarn" }
    case "composer":
      return {
        command: "composer",
        args: ["install", "--no-interaction"],
        packageManager: "composer",
      }
  }
}

const parsePackageManagerField = (
  value: unknown,
): NodePackageManager | null => {
  if (typeof value !== "string") {
    return null
  }
  const name = value.trim().split("@")[0]?.toLowerCase()
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
    return name
  }
  return null
}

type PackageJsonContents =
  | { readonly packageManager?: unknown }
  | { readonly packageManager: undefined; readonly _invalid: true }

const parsePackageJsonContents = (raw: string): PackageJsonContents => {
  try {
    return JSON.parse(raw) as { readonly packageManager?: unknown }
  } catch {
    return { packageManager: undefined, _invalid: true }
  }
}

const readPackageJson = (worktreePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const packageJsonPath = path.join(worktreePath, "package.json")
    const exists = yield* fs.exists(packageJsonPath)
    if (!exists) {
      return null
    }
    const raw = yield* fs.readFileString(packageJsonPath)
    return parsePackageJsonContents(raw)
  })

const listPresentNodeLockfiles = (worktreePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const present: Array<{
      readonly file: string
      readonly manager: NodePackageManager
    }> = []
    for (const entry of NODE_LOCKFILES) {
      if (yield* fs.exists(path.join(worktreePath, entry.file))) {
        present.push(entry)
      }
    }
    return present
  })

/**
 * Derive a direct install command from root metadata and lockfiles only.
 * Never executes repository-controlled shell text; returns Fallback when
 * the layout is ambiguous, conflicting, or unsupported.
 */
export const detectInstallPlan = (worktreePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const packageJson = yield* readPackageJson(worktreePath)
    const hasPackageJson = packageJson !== null
    const hasComposerJson = yield* fs.exists(
      path.join(worktreePath, "composer.json"),
    )
    const lockfiles = yield* listPresentNodeLockfiles(worktreePath)

    if (hasPackageJson && hasComposerJson) {
      return {
        _tag: "Fallback",
        reason:
          "Root package.json and composer.json both present; install manager is ambiguous",
      } satisfies InstallPlan
    }

    if (hasComposerJson && !hasPackageJson) {
      return {
        _tag: "Direct",
        install: installFor("composer"),
      } satisfies InstallPlan
    }

    if (!hasPackageJson) {
      if (lockfiles.length > 0) {
        return {
          _tag: "Fallback",
          reason:
            "Node lockfile present without package.json; install manager is unsupported",
        } satisfies InstallPlan
      }
      return {
        _tag: "Fallback",
        reason: "No recognizable root package manager metadata or lockfile",
      } satisfies InstallPlan
    }

    if (
      packageJson !== null &&
      "_invalid" in packageJson &&
      packageJson._invalid
    ) {
      return {
        _tag: "Fallback",
        reason: "Root package.json is not valid JSON",
      } satisfies InstallPlan
    }

    const fieldManager = parsePackageManagerField(packageJson?.packageManager)
    const lockManagers = [...new Set(lockfiles.map((entry) => entry.manager))]

    if (Object.hasOwn(packageJson, "packageManager") && fieldManager === null) {
      return {
        _tag: "Fallback",
        reason: `Unsupported packageManager field: ${String(packageJson.packageManager)}`,
      } satisfies InstallPlan
    }

    if (lockManagers.length > 1) {
      return {
        _tag: "Fallback",
        reason: `Conflicting Node lockfiles for managers: ${lockManagers.join(", ")}`,
      } satisfies InstallPlan
    }

    const lockManager = lockManagers[0]

    if (
      fieldManager !== null &&
      lockManager !== undefined &&
      fieldManager !== lockManager
    ) {
      return {
        _tag: "Fallback",
        reason: `packageManager field (${fieldManager}) conflicts with lockfile manager (${lockManager})`,
      } satisfies InstallPlan
    }

    if (fieldManager !== null) {
      return {
        _tag: "Direct",
        install: installFor(fieldManager),
      } satisfies InstallPlan
    }

    if (lockManager !== undefined) {
      return {
        _tag: "Direct",
        install: installFor(lockManager),
      } satisfies InstallPlan
    }

    return {
      _tag: "Fallback",
      reason:
        "package.json present without packageManager field or a recognized lockfile",
    } satisfies InstallPlan
  })
