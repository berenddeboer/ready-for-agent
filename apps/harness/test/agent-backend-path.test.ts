import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import {
  assertNoAmbientAgentCliOnProductPath,
  buildProductPath,
  directoryProvidesBinary,
  pathWithoutBinaries,
  resolveAgentBackendE2eMode,
} from "../e2e/support/agent-backend-path.ts"
import { afterEach, describe, expect, test } from "bun:test"

describe("resolveAgentBackendE2eMode", () => {
  test("defaults to default when unset or empty", () => {
    expect(resolveAgentBackendE2eMode({})).toBe("default")
    expect(resolveAgentBackendE2eMode({ E2E_AGENT_BACKEND_MODE: "" })).toBe(
      "default",
    )
    expect(
      resolveAgentBackendE2eMode({ E2E_AGENT_BACKEND_MODE: "  default  " }),
    ).toBe("default")
  })

  test("accepts no-opencode", () => {
    expect(
      resolveAgentBackendE2eMode({ E2E_AGENT_BACKEND_MODE: "no-opencode" }),
    ).toBe("no-opencode")
    expect(
      resolveAgentBackendE2eMode({ E2E_AGENT_BACKEND_MODE: "NO-OPENCODE" }),
    ).toBe("no-opencode")
  })

  test("fails closed on unknown values", () => {
    expect(() =>
      resolveAgentBackendE2eMode({ E2E_AGENT_BACKEND_MODE: "maybe" }),
    ).toThrow(/E2E_AGENT_BACKEND_MODE/)
  })
})

describe("pathWithoutBinaries / directoryProvidesBinary", () => {
  let root: string | undefined

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  test("strips directories that provide any listed binary and keeps others", () => {
    root = mkdtempSync(join(tmpdir(), "agent-backend-path-"))
    const withOpenCode = join(root, "with-opencode")
    const withGrok = join(root, "with-grok")
    const without = join(root, "plain")
    mkdirSync(withOpenCode, { recursive: true })
    mkdirSync(withGrok, { recursive: true })
    mkdirSync(without, { recursive: true })
    writeFileSync(join(withOpenCode, "opencode"), "#!/bin/sh\n")
    chmodSync(join(withOpenCode, "opencode"), 0o755)
    writeFileSync(join(withGrok, "grok"), "#!/bin/sh\n")
    chmodSync(join(withGrok, "grok"), 0o755)

    expect(directoryProvidesBinary(withOpenCode, "opencode")).toBe(true)
    expect(directoryProvidesBinary(without, "opencode")).toBe(false)

    const ambient = [withOpenCode, without, withGrok].join(delimiter)
    const filtered = pathWithoutBinaries(ambient, ["opencode", "grok", "codex"])
    expect(filtered.split(delimiter)).toEqual([without])
  })
})

describe("buildProductPath / assertNoAmbientAgentCliOnProductPath", () => {
  test("always prepends the fake CLI bin dir", () => {
    const path = buildProductPath({
      mode: "default",
      fakeCliBinDir: "/tmp/fake-bin",
      ambientPath: "/usr/bin",
    })
    expect(path.startsWith(`/tmp/fake-bin${delimiter}`)).toBe(true)
    expect(path).toContain("/usr/bin")
  })

  test("no-opencode mode fails when which still finds opencode", () => {
    expect(() =>
      assertNoAmbientAgentCliOnProductPath({
        mode: "no-opencode",
        productPath: "/tmp/product",
        fakeCliBinDir: "/tmp/fake-bin",
        which: (command) =>
          command === "opencode" ? "/leaked/opencode" : null,
      }),
    ).toThrow(/opencode/)
  })

  test("no-opencode mode requires fake claude and rejects ambient claude", () => {
    expect(() =>
      assertNoAmbientAgentCliOnProductPath({
        mode: "no-opencode",
        productPath: "/tmp/product",
        fakeCliBinDir: "/tmp/fake-bin",
        which: () => null,
      }),
    ).toThrow(/fake claude/)

    expect(() =>
      assertNoAmbientAgentCliOnProductPath({
        mode: "no-opencode",
        productPath: "/tmp/product",
        fakeCliBinDir: "/tmp/fake-bin",
        which: (command) => (command === "claude" ? "/ambient/claude" : null),
      }),
    ).toThrow(/fake claude/)

    expect(() =>
      assertNoAmbientAgentCliOnProductPath({
        mode: "no-opencode",
        productPath: "/tmp/fake-bin:/tmp/product",
        fakeCliBinDir: "/tmp/fake-bin",
        which: (command) =>
          command === "claude" ? "/tmp/fake-bin/claude" : null,
      }),
    ).not.toThrow()
  })

  test("default mode never asserts absence", () => {
    expect(() =>
      assertNoAmbientAgentCliOnProductPath({
        mode: "default",
        productPath: "/tmp/product",
        fakeCliBinDir: "/tmp/fake-bin",
        which: () => "/anywhere/opencode",
      }),
    ).not.toThrow()
  })
})
