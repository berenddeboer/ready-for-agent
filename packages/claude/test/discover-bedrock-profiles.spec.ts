import {
  CLAUDE_THINKING_LEVELS,
  EMPTY_BEDROCK_SYSTEM_DEFINED_CATALOG_WARNING,
  bedrockProfilesToAgentModels,
  finalizeBedrockDiscoveryModels,
  formatBedrockDiscoveryFailure,
  resolveBedrockRegion,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const anthropicArn =
  "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6"

const profile = (overrides: {
  id?: string
  status?: string
  type?: string
  models?: ReadonlyArray<{ modelArn?: string | null }> | null
}) => ({
  inferenceProfileId: overrides.id ?? "us.anthropic.claude-sonnet-4-6",
  inferenceProfileName: "US Anthropic Claude Sonnet 4.6",
  status: overrides.status ?? "ACTIVE",
  type: overrides.type ?? "SYSTEM_DEFINED",
  models: overrides.models ?? [{ modelArn: anthropicArn }],
})

describe("bedrockProfilesToAgentModels (issue #820)", () => {
  it("keeps only ACTIVE SYSTEM_DEFINED Anthropic-backed profiles by id", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "us.anthropic.claude-sonnet-4-6" }),
      profile({
        id: "us.anthropic.claude-opus-4-6",
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-4-6",
          },
        ],
      }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-opus-4-6",
      "us.anthropic.claude-sonnet-4-6",
    ])
    for (const model of models) {
      expect(model.thinkingLevels).toEqual([...CLAUDE_THINKING_LEVELS])
    }
  })

  it("filters inactive, application, and non-Anthropic profiles", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "inactive", status: "INACTIVE" }),
      profile({
        id: "app-profile",
        type: "APPLICATION",
      }),
      profile({
        id: "amazon.titan",
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-text-express-v1",
          },
        ],
      }),
      profile({ id: "us.anthropic.claude-haiku-4-5" }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-haiku-4-5",
    ])
  })

  it("deduplicates by inference profile id and sorts deterministically", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "us.anthropic.z" }),
      profile({ id: "us.anthropic.a" }),
      profile({ id: "us.anthropic.z" }),
      profile({ id: "us.anthropic.m" }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.a",
      "us.anthropic.m",
      "us.anthropic.z",
    ])
  })

  it("skips blank ids; keeps id-only Anthropic profiles when models are missing", () => {
    const models = bedrockProfilesToAgentModels([
      {
        inferenceProfileId: "  ",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: [{ modelArn: anthropicArn }],
      },
      {
        inferenceProfileId: "us.anthropic.ok",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: null,
      },
      {
        inferenceProfileId: "us.anthropic.empty-models",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: [],
      },
      {
        // Non-Anthropic id and no Anthropic model ARNs → drop.
        inferenceProfileId: "us.amazon.titan",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: null,
      },
      profile({ id: "us.anthropic.kept" }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.empty-models",
      "us.anthropic.kept",
      "us.anthropic.ok",
    ])
  })

  it("treats profile id containing anthropic. as Anthropic-backed", () => {
    const models = bedrockProfilesToAgentModels([
      {
        inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: undefined,
      },
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-sonnet-4-6",
    ])
  })
})

describe("finalizeBedrockDiscoveryModels", () => {
  it("adds a soft warning when the filtered catalog is empty", () => {
    expect(finalizeBedrockDiscoveryModels([])).toEqual({
      models: [],
      warning: EMPTY_BEDROCK_SYSTEM_DEFINED_CATALOG_WARNING,
    })
    expect(EMPTY_BEDROCK_SYSTEM_DEFINED_CATALOG_WARNING).toContain(
      "Free-text Agent Model entry remains available",
    )
  })

  it("returns null warning when at least one model is present", () => {
    const models = [
      {
        id: "us.anthropic.claude-sonnet-4-6",
        thinkingLevels: [...CLAUDE_THINKING_LEVELS],
      },
    ]
    expect(finalizeBedrockDiscoveryModels(models)).toEqual({
      models,
      warning: null,
    })
  })
})

describe("resolveBedrockRegion", () => {
  it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
    expect(
      resolveBedrockRegion({
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-west-2",
      }),
    ).toBe("us-east-1")
  })

  it("falls back to AWS_DEFAULT_REGION", () => {
    expect(
      resolveBedrockRegion({
        AWS_DEFAULT_REGION: "eu-west-1",
      }),
    ).toBe("eu-west-1")
  })

  it("returns undefined when neither region is set", () => {
    expect(resolveBedrockRegion({ AWS_PROFILE: "bedrock-op" })).toBeUndefined()
  })
})

describe("formatBedrockDiscoveryFailure", () => {
  it("maps access denied, credentials, throttle, region, and timeout causes", () => {
    expect(
      formatBedrockDiscoveryFailure({ name: "AccessDeniedException" }),
    ).toContain("access denied")
    expect(
      formatBedrockDiscoveryFailure({
        name: "ExpiredTokenException",
        message: "The security token included in the request is expired",
      }),
    ).toContain("credentials")
    expect(
      formatBedrockDiscoveryFailure({ name: "ThrottlingException" }),
    ).toContain("throttled")
    expect(
      formatBedrockDiscoveryFailure({
        message: "Region is missing",
      }),
    ).toContain("region")
    expect(formatBedrockDiscoveryFailure({ _tag: "TimeoutError" })).toContain(
      "timed out",
    )
    expect(
      formatBedrockDiscoveryFailure({ name: "AbortError", message: "aborted" }),
    ).toContain("timed out")
    for (const text of [
      formatBedrockDiscoveryFailure({ name: "AccessDeniedException" }),
      formatBedrockDiscoveryFailure({ name: "ThrottlingException" }),
      formatBedrockDiscoveryFailure({ _tag: "TimeoutError" }),
    ]) {
      expect(text).toContain("Free-text Agent Model entry remains available")
      // Never embed raw secret-like material from the error path.
      expect(text).not.toMatch(/AKIA|aws_secret|password=/i)
    }
  })
})
