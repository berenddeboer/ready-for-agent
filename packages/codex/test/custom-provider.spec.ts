import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  interpretCodexUserConfig,
  resolveCodexUserProvider,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const AZURE_CONFIG = `
model = "gpt-5.6-terra"
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai"
wire_api = "responses"

[model_providers.azure.auth]
command = "/usr/local/bin/fetch-codex-token"
args = ["--audience", "codex"]
`.trim()

const withCodexHome = async <A>(
  files: Readonly<Record<string, string>>,
  use: (codexHome: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-user-config-"))
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(directory, name)
      await writeFile(path, content)
      if (name.endsWith(".sh")) {
        await chmod(path, 0o700)
      }
    }
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("interpretCodexUserConfig", () => {
  it("recognizes a documented Azure command-backed custom provider", () => {
    expect(interpretCodexUserConfig(AZURE_CONFIG)).toEqual({
      kind: "custom",
      providerId: "azure",
    })
  })

  it("treats a custom provider with env_key auth as custom", () => {
    expect(
      interpretCodexUserConfig(`
model_provider = "proxy"

[model_providers.proxy]
name = "OpenAI using LLM proxy"
base_url = "http://proxy.example.com"
env_key = "OPENAI_API_KEY"
`),
    ).toEqual({
      kind: "custom",
      providerId: "proxy",
    })
  })

  it("treats missing or first-party model_provider as first-party", () => {
    expect(interpretCodexUserConfig('model = "gpt-5.6-terra"\n')).toEqual({
      kind: "firstParty",
    })
    expect(interpretCodexUserConfig('model_provider = "openai"\n')).toEqual({
      kind: "firstParty",
    })
    expect(interpretCodexUserConfig('model_provider = ""\n')).toEqual({
      kind: "firstParty",
    })
  })

  it("treats reserved built-in providers as first-party", () => {
    expect(interpretCodexUserConfig('model_provider = "ollama"\n')).toEqual({
      kind: "firstParty",
    })
    expect(interpretCodexUserConfig('model_provider = "lmstudio"\n')).toEqual({
      kind: "firstParty",
    })
    expect(
      interpretCodexUserConfig(`
model_provider = "amazon-bedrock"
[model_providers.amazon-bedrock.aws]
region = "eu-central-1"
`),
    ).toEqual({ kind: "firstParty" })
  })

  it("rejects invalid TOML", () => {
    const result = interpretCodexUserConfig("model_provider = [\n")
    expect(result.kind).toBe("malformed")
    if (result.kind === "malformed") {
      expect(result.message).toContain("valid TOML")
    }
  })

  it("rejects a selected custom provider that is not defined", () => {
    const result = interpretCodexUserConfig('model_provider = "azure"\n')
    expect(result.kind).toBe("malformed")
    if (result.kind === "malformed") {
      expect(result.message).toContain("azure")
      expect(result.message).toContain("model_providers")
    }
  })

  it("rejects a custom provider table without base_url", () => {
    const result = interpretCodexUserConfig(`
model_provider = "azure"
[model_providers.azure]
name = "Azure"
`)
    expect(result.kind).toBe("malformed")
    if (result.kind === "malformed") {
      expect(result.message).toContain("base_url")
    }
  })

  it("rejects a non-string model_provider", () => {
    const result = interpretCodexUserConfig("model_provider = 1\n")
    expect(result.kind).toBe("malformed")
    if (result.kind === "malformed") {
      expect(result.message).toContain("model_provider")
    }
  })
})

describe("resolveCodexUserProvider", () => {
  it("reads user-level config.toml from CODEX_HOME", async () => {
    await withCodexHome({ "config.toml": AZURE_CONFIG }, async (codexHome) => {
      expect(
        resolveCodexUserProvider({ env: { CODEX_HOME: codexHome } }),
      ).toEqual({
        kind: "custom",
        providerId: "azure",
      })
    })
  })

  it("treats a missing config.toml as first-party", async () => {
    await withCodexHome({}, async (codexHome) => {
      expect(
        resolveCodexUserProvider({ env: { CODEX_HOME: codexHome } }),
      ).toEqual({ kind: "firstParty" })
    })
  })

  it("does not execute a configured auth command while resolving", async () => {
    await withCodexHome({}, async (codexHome) => {
      const marker = join(codexHome, "token-ran")
      const command = join(codexHome, "token.sh")
      await writeFile(
        command,
        `#!/bin/sh\necho ran > "${marker}"\necho fake-token\n`,
      )
      await chmod(command, 0o700)
      await writeFile(
        join(codexHome, "config.toml"),
        `
model_provider = "azure"
[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai"
wire_api = "responses"
[model_providers.azure.auth]
command = ${JSON.stringify(command)}
`,
      )

      expect(
        resolveCodexUserProvider({ env: { CODEX_HOME: codexHome } }),
      ).toEqual({
        kind: "custom",
        providerId: "azure",
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    })
  })
})
