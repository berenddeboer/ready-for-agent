import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import { detectInstallPlan } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof PlatformLayer>>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(PlatformLayer)))

const withTemp = async (
  setup: (root: string) => Promise<void>,
  assert: (root: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-detect-install-"))
  try {
    await setup(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("detectInstallPlan", () => {
  it("selects bun from bun.lock", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lock"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "bun",
            args: ["install"],
            packageManager: "bun",
          },
        })
      },
    ))

  it("selects bun from bun.lockb", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lockb"), "binary")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Direct")
        if (plan._tag === "Direct") {
          expect(plan.install.packageManager).toBe("bun")
        }
      },
    ))

  it("selects npm from package-lock.json", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "npm",
            args: ["install"],
            packageManager: "npm",
          },
        })
      },
    ))

  it("selects pnpm from pnpm-lock.yaml", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "pnpm",
            args: ["install"],
            packageManager: "pnpm",
          },
        })
      },
    ))

  it("selects yarn from yarn.lock", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "yarn.lock"), "# yarn\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "yarn",
            args: ["install"],
            packageManager: "yarn",
          },
        })
      },
    ))

  it("selects manager from packageManager field when no lockfile", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "pnpm@9.0.0" }),
        )
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "pnpm",
            args: ["install"],
            packageManager: "pnpm",
          },
        })
      },
    ))

  it("uses packageManager when it agrees with lockfile", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "npm@10.0.0" }),
        )
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Direct")
        if (plan._tag === "Direct") {
          expect(plan.install.packageManager).toBe("npm")
        }
      },
    ))

  it("falls back when packageManager conflicts with lockfile", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "yarn@1.22.0" }),
        )
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("conflicts")
        }
      },
    ))

  it("falls back when packageManager is unsupported despite a recognized lockfile", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ packageManager: "deno@2.0.0" }),
        )
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("Unsupported packageManager")
        }
      },
    ))

  it("falls back when multiple node lockfiles conflict", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "yarn.lock"), "# yarn\n")
        await writeFile(join(root, "package-lock.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("Conflicting")
        }
      },
    ))

  it("selects composer when only composer.json is present", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "composer.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "composer",
            args: ["install", "--no-interaction"],
            packageManager: "composer",
          },
        })
      },
    ))

  it("falls back when package.json and composer.json both present", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "composer.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
      },
    ))

  it("returns a no-op plan when no recognizable manager exists", () =>
    withTemp(
      async () => {
        // empty directory
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({ _tag: "NoOp" })
      },
    ))

  it("falls back for package.json without packageManager or lockfile", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
      },
    ))

  it("falls back for a root requirements.txt", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "requirements.txt"), "requests==2.32.0\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("requirements.txt")
        }
      },
    ))

  it("falls back for a root pyproject.toml", () =>
    withTemp(
      async (root) => {
        await writeFile(
          join(root, "pyproject.toml"),
          '[project]\nname = "demo"\n',
        )
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("pyproject.toml")
        }
      },
    ))

  it("falls back for a root Cargo.toml", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "Cargo.toml"), '[package]\nname = "demo"\n')
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("Cargo.toml")
        }
      },
    ))

  it("falls back once when multiple Python and Rust manifests are present", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "requirements.txt"), "requests==2.32.0\n")
        await writeFile(
          join(root, "pyproject.toml"),
          '[project]\nname = "demo"\n',
        )
        await writeFile(join(root, "Cargo.toml"), '[package]\nname = "demo"\n')
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan._tag).toBe("Fallback")
        if (plan._tag === "Fallback") {
          expect(plan.reason).toContain("requirements.txt")
          expect(plan.reason).toContain("pyproject.toml")
          expect(plan.reason).toContain("Cargo.toml")
        }
      },
    ))

  it("ignores Python and Rust manifests in subdirectories", () =>
    withTemp(
      async (root) => {
        await mkdir(join(root, "nested"), { recursive: true })
        await writeFile(join(root, "nested", "requirements.txt"), "requests\n")
        await writeFile(join(root, "nested", "pyproject.toml"), "[project]\n")
        await writeFile(join(root, "nested", "Cargo.toml"), "[package]\n")
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({ _tag: "NoOp" })
      },
    ))

  it("keeps a Node direct plan when Cargo.toml is also present", () =>
    withTemp(
      async (root) => {
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "bun.lock"), "{}\n")
        await writeFile(join(root, "Cargo.toml"), '[package]\nname = "demo"\n')
      },
      async (root) => {
        const plan = await run(detectInstallPlan(root))
        expect(plan).toEqual({
          _tag: "Direct",
          install: {
            command: "bun",
            args: ["install"],
            packageManager: "bun",
          },
        })
      },
    ))
})
