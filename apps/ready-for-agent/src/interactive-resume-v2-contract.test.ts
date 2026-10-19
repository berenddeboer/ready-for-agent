import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCodeModelPinArguments } from "./interactive-resume.ts"
import { describe, expect, test } from "bun:test"

const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8" })
const versionText = `${opencode.stdout ?? ""}\n${opencode.stderr ?? ""}`
const installedV2 =
  opencode.status === 0 && /(?:^|\s)v?2\.\d+\.\d+/.test(versionText)

const outputOf = (result: {
  readonly stdout?: string
  readonly stderr?: string
}): string => `${result.stdout ?? ""}\n${result.stderr ?? ""}`

const rejectBeforeInference = (args: ReadonlyArray<string>) =>
  spawnSync("opencode", [...args, "--bogus"], {
    encoding: "utf8",
    timeout: 15_000,
  })

describe.skipIf(!installedV2)(
  "installed OpenCode V2 jump continuation contract",
  () => {
    test("root TUI rejects model flags and accepts the session model API pin", () => {
      const pin = openCodeModelPinArguments({
        sessionId: "ses_contract",
        workingDirectory: "/tmp/work-item",
        agentModel: "provider/model",
        thinkingLevel: "high",
      })
      expect(pin).toBeDefined()
      if (pin === undefined) {
        return
      }
      expect(pin).not.toContain("-m")
      expect(pin).not.toContain("--model")

      const accepted = rejectBeforeInference(pin)
      const acceptedOutput = outputOf(accepted)
      expect(accepted.status).toBe(1)
      expect(acceptedOutput).toContain("Unrecognized flag: --bogus")
      expect(acceptedOutput).not.toContain("Unrecognized flag: --header")
      expect(acceptedOutput).not.toContain("Unrecognized flag: --data")
      expect(acceptedOutput).not.toContain("Unrecognized flag: -m")

      for (const flag of ["-m", "--model"] as const) {
        const rejected = spawnSync(
          "opencode",
          [
            "/tmp",
            "--session",
            "ses_contract",
            "--auto",
            flag,
            "provider/model",
          ],
          { encoding: "utf8", timeout: 15_000 },
        )
        const rejectedOutput = outputOf(rejected)
        expect(rejected.status).toBe(1)
        expect(rejectedOutput).toContain(`Unrecognized flag: ${flag}`)
      }

      const resume = rejectBeforeInference([
        "/tmp",
        "--session",
        "ses_contract",
        "--auto",
      ])
      const resumeOutput = outputOf(resume)
      expect(resume.status).toBe(1)
      expect(resumeOutput).toContain("Unrecognized flag: --bogus")
      expect(resumeOutput).not.toContain("Unrecognized flag: --session")
      expect(resumeOutput).not.toContain("Unrecognized flag: --auto")
    })

    test("a real session keeps the pinned model across a V2 TUI attach", () => {
      const directory = mkdtempSync(join(tmpdir(), "rfa-opencode-pin-"))
      const header = `x-opencode-directory:${encodeURIComponent(directory)}`
      let sessionId: string | undefined
      try {
        const created = spawnSync(
          "opencode",
          [
            "api",
            "--header",
            header,
            "post",
            "/api/session",
            "--data",
            JSON.stringify({
              location: { directory },
              title: "rfa-jump-model-contract",
            }),
          ],
          { encoding: "utf8", timeout: 20_000 },
        )
        expect(created.status).toBe(0)
        const createdBody: unknown = JSON.parse(created.stdout)
        if (
          typeof createdBody !== "object" ||
          createdBody === null ||
          !("data" in createdBody)
        ) {
          throw new Error("OpenCode did not return a created session")
        }
        const data = createdBody.data
        if (
          typeof data !== "object" ||
          data === null ||
          !("id" in data) ||
          typeof data.id !== "string"
        ) {
          throw new Error("OpenCode did not return a session id")
        }
        sessionId = data.id
        const catalog = readDefaultModel(directory)
        const pin = openCodeModelPinArguments({
          sessionId,
          workingDirectory: directory,
          agentModel: `${catalog.providerID}/${catalog.id}`,
          thinkingLevel: catalog.thinkingLevel,
        })
        expect(pin).toBeDefined()
        if (pin === undefined) {
          return
        }
        const switched = spawnSync("opencode", [...pin], {
          encoding: "utf8",
          timeout: 20_000,
        })
        expect(switched.status).toBe(0)

        const before = readSessionModel(sessionId)
        expect(before).toMatchObject({
          id: catalog.id,
          providerID: catalog.providerID,
          ...(catalog.thinkingLevel === null
            ? {}
            : { variant: catalog.thinkingLevel }),
        })

        spawnSync("opencode", [directory, "--session", sessionId, "--auto"], {
          encoding: "utf8",
          timeout: 4_000,
        })

        expect(readSessionModel(sessionId)).toEqual(before)
      } finally {
        if (sessionId !== undefined) {
          spawnSync("opencode", ["session", "delete", sessionId], {
            encoding: "utf8",
            timeout: 20_000,
          })
        }
        rmSync(directory, { recursive: true, force: true })
      }
    })
  },
)

const readDefaultModel = (
  directory: string,
): {
  readonly providerID: string
  readonly id: string
  readonly thinkingLevel: string | null
} => {
  const result = spawnSync(
    "opencode",
    [
      "api",
      "--header",
      `x-opencode-directory:${encodeURIComponent(directory)}`,
      "get",
      "/api/model/default",
    ],
    { encoding: "utf8", timeout: 20_000 },
  )
  expect(result.status).toBe(0)
  const body: unknown = JSON.parse(result.stdout)
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new Error("OpenCode default model response has no data")
  }
  const data = body.data
  if (
    typeof data !== "object" ||
    data === null ||
    !("providerID" in data) ||
    !("id" in data) ||
    typeof data.providerID !== "string" ||
    typeof data.id !== "string"
  ) {
    throw new Error("OpenCode default model has no provider/model identity")
  }
  const variants = "variants" in data ? data.variants : undefined
  const hasHigh =
    Array.isArray(variants) &&
    variants.some(
      (variant) =>
        typeof variant === "object" &&
        variant !== null &&
        "id" in variant &&
        variant.id === "high",
    )
  return {
    providerID: data.providerID,
    id: data.id,
    thinkingLevel: hasHigh ? "high" : null,
  }
}

const readSessionModel = (sessionId: string): unknown => {
  const result = spawnSync(
    "opencode",
    ["api", "get", `/api/session/${sessionId}`],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  )
  expect(result.status).toBe(0)
  const body: unknown = JSON.parse(result.stdout)
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new Error("OpenCode session response has no data")
  }
  const data = body.data
  if (typeof data !== "object" || data === null || !("model" in data)) {
    throw new Error("OpenCode session response has no model")
  }
  return data.model
}
