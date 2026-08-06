import {
  BEDROCK_PROFILE_KIND_APPLICATION,
  BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
  CLAUDE_THINKING_LEVELS,
  EMPTY_BEDROCK_CATALOG_WARNING,
  bedrockProfileExecutableId,
  bedrockProfilesToAgentModels,
  finalizeBedrockDiscoveryModels,
  formatBedrockDiscoveryFailure,
  regionFromAwsConfigText,
  resolveBedrockRegion,
  scrubBedrockDiscoverySecrets,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const anthropicArn =
  "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6"

const appArn =
  "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"

const profile = (overrides: {
  id?: string | null
  name?: string | null
  arn?: string | null
  status?: string
  type?: string
  models?: ReadonlyArray<{ modelArn?: string | null }> | null
}) => ({
  inferenceProfileId:
    overrides.id === undefined
      ? "us.anthropic.claude-sonnet-4-6"
      : overrides.id,
  inferenceProfileName:
    overrides.name === undefined
      ? "US Anthropic Claude Sonnet 4.6"
      : overrides.name,
  inferenceProfileArn:
    overrides.arn === undefined
      ? "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6"
      : overrides.arn,
  status: overrides.status ?? "ACTIVE",
  type: overrides.type ?? BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
  models: overrides.models ?? [{ modelArn: anthropicArn }],
})

describe("bedrockProfilesToAgentModels (issues #820 / #821)", () => {
  it("keeps ACTIVE SYSTEM_DEFINED Anthropic profiles by id with friendly name and kind", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "us.anthropic.claude-sonnet-4-6" }),
      profile({
        id: "us.anthropic.claude-opus-4-6",
        name: "US Anthropic Claude Opus 4.6",
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
    expect(models[0]).toMatchObject({
      id: "us.anthropic.claude-opus-4-6",
      name: "US Anthropic Claude Opus 4.6",
      kind: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
      thinkingLevels: [...CLAUDE_THINKING_LEVELS],
    })
    expect(models[1]).toMatchObject({
      id: "us.anthropic.claude-sonnet-4-6",
      name: "US Anthropic Claude Sonnet 4.6",
      kind: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
    })
  })

  it("includes ACTIVE APPLICATION Anthropic profiles by ARN with friendly name", () => {
    const models = bedrockProfilesToAgentModels([
      profile({
        id: "app-profile-local-id",
        name: "My Org Sonnet",
        arn: appArn,
        type: BEDROCK_PROFILE_KIND_APPLICATION,
        models: [{ modelArn: anthropicArn }],
      }),
    ])
    expect(models).toEqual([
      {
        id: appArn,
        name: "My Org Sonnet",
        kind: BEDROCK_PROFILE_KIND_APPLICATION,
        thinkingLevels: [...CLAUDE_THINKING_LEVELS],
      },
    ])
    // Executable value is the ARN, never the local application profile id.
    expect(models[0]?.id).not.toBe("app-profile-local-id")
  })

  it("filters inactive and non-Anthropic profiles; keeps both system and application", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "inactive", status: "INACTIVE" }),
      profile({
        id: "amazon.titan",
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-text-express-v1",
          },
        ],
      }),
      profile({
        id: "non-anthropic-app",
        arn: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/titan-app",
        type: BEDROCK_PROFILE_KIND_APPLICATION,
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-text-express-v1",
          },
        ],
      }),
      profile({ id: "us.anthropic.claude-haiku-4-5" }),
      profile({
        id: "app-ok",
        name: "Haiku App",
        arn: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/haiku-app",
        type: BEDROCK_PROFILE_KIND_APPLICATION,
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5",
          },
        ],
      }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-haiku-4-5",
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/haiku-app",
    ])
    expect(models.map((model) => model.kind)).toEqual([
      BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
      BEDROCK_PROFILE_KIND_APPLICATION,
    ])
  })

  it("orders system-defined before application, then by executable id deterministically", () => {
    const models = bedrockProfilesToAgentModels([
      profile({
        id: "z-app",
        name: "Z App",
        arn: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/z",
        type: BEDROCK_PROFILE_KIND_APPLICATION,
      }),
      profile({
        id: "us.anthropic.z",
        name: "Z System",
      }),
      profile({
        id: "a-app",
        name: "A App",
        arn: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/a",
        type: BEDROCK_PROFILE_KIND_APPLICATION,
      }),
      profile({
        id: "us.anthropic.a",
        name: "A System",
      }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.a",
      "us.anthropic.z",
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/a",
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/z",
    ])
  })

  it("deduplicates by executable id (system id / application ARN)", () => {
    const models = bedrockProfilesToAgentModels([
      profile({ id: "us.anthropic.z", name: "First" }),
      profile({ id: "us.anthropic.a" }),
      profile({ id: "us.anthropic.z", name: "Duplicate ignored" }),
      profile({
        id: "dup-app",
        name: "App First",
        arn: appArn,
        type: BEDROCK_PROFILE_KIND_APPLICATION,
      }),
      profile({
        id: "dup-app-2",
        name: "App Duplicate ignored",
        arn: appArn,
        type: BEDROCK_PROFILE_KIND_APPLICATION,
      }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.a",
      "us.anthropic.z",
      appArn,
    ])
    expect(models.find((model) => model.id === "us.anthropic.z")?.name).toBe(
      "First",
    )
    expect(models.find((model) => model.id === appArn)?.name).toBe("App First")
  })

  it("skips malformed summaries: blank system id, blank application ARN, unknown type", () => {
    const models = bedrockProfilesToAgentModels([
      {
        inferenceProfileId: "  ",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
        models: [{ modelArn: anthropicArn }],
      },
      {
        inferenceProfileId: "us.anthropic.ok",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
        models: null,
      },
      {
        inferenceProfileId: "us.anthropic.empty-models",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
        models: [],
      },
      {
        // Non-Anthropic id and no Anthropic model ARNs → drop.
        inferenceProfileId: "us.amazon.titan",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
        models: null,
      },
      {
        inferenceProfileId: "app-missing-arn",
        inferenceProfileArn: "  ",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_APPLICATION,
        models: [{ modelArn: anthropicArn }],
      },
      {
        inferenceProfileId: "unknown-type",
        status: "ACTIVE",
        type: "SOMETHING_ELSE",
        models: [{ modelArn: anthropicArn }],
      },
      profile({ id: "us.anthropic.kept" }),
      profile({
        id: "app-kept",
        name: "Kept App",
        arn: appArn,
        type: BEDROCK_PROFILE_KIND_APPLICATION,
      }),
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.empty-models",
      "us.anthropic.kept",
      "us.anthropic.ok",
      appArn,
    ])
  })

  it("omits name when blank or identical to the executable id", () => {
    const models = bedrockProfilesToAgentModels([
      profile({
        id: "us.anthropic.no-name",
        name: "   ",
      }),
      profile({
        id: "us.anthropic.self-named",
        name: "us.anthropic.self-named",
      }),
    ])
    for (const model of models) {
      expect(model.name).toBeUndefined()
      expect(model.kind).toBe(BEDROCK_PROFILE_KIND_SYSTEM_DEFINED)
    }
  })

  it("treats profile id containing anthropic. as Anthropic-backed", () => {
    const models = bedrockProfilesToAgentModels([
      {
        inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
        status: "ACTIVE",
        type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
        models: undefined,
      },
    ])
    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-sonnet-4-6",
    ])
  })

  it("bedrockProfileExecutableId maps system id and application ARN", () => {
    expect(
      bedrockProfileExecutableId(
        profile({ id: "us.anthropic.claude-sonnet-4-6" }),
      ),
    ).toBe("us.anthropic.claude-sonnet-4-6")
    expect(
      bedrockProfileExecutableId(
        profile({
          id: "local",
          arn: appArn,
          type: BEDROCK_PROFILE_KIND_APPLICATION,
        }),
      ),
    ).toBe(appArn)
    expect(
      bedrockProfileExecutableId(
        profile({ id: "  ", type: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED }),
      ),
    ).toBeNull()
    expect(
      bedrockProfileExecutableId(
        profile({
          arn: "  ",
          type: BEDROCK_PROFILE_KIND_APPLICATION,
        }),
      ),
    ).toBeNull()
  })
})

describe("finalizeBedrockDiscoveryModels", () => {
  it("adds a soft warning when the filtered catalog is empty", () => {
    expect(finalizeBedrockDiscoveryModels([])).toEqual({
      models: [],
      warning: EMPTY_BEDROCK_CATALOG_WARNING,
    })
    expect(EMPTY_BEDROCK_CATALOG_WARNING).toContain(
      "Free-text Agent Model entry remains available",
    )
  })

  it("returns null warning when at least one model is present", () => {
    const models = [
      {
        id: "us.anthropic.claude-sonnet-4-6",
        thinkingLevels: [...CLAUDE_THINKING_LEVELS],
        name: "US Anthropic Claude Sonnet 4.6",
        kind: BEDROCK_PROFILE_KIND_SYSTEM_DEFINED,
      },
    ]
    expect(finalizeBedrockDiscoveryModels(models)).toEqual({
      models,
      warning: null,
    })
  })
})

describe("resolveBedrockRegion (issue #822)", () => {
  it("prefers AWS_REGION over AWS_DEFAULT_REGION and named-profile region", () => {
    expect(
      resolveBedrockRegion(
        {
          AWS_REGION: "us-east-1",
          AWS_DEFAULT_REGION: "us-west-2",
          AWS_PROFILE: "bedrock-op",
        },
        {
          readTextFile: () => "[profile bedrock-op]\nregion = eu-central-1\n",
        },
      ),
    ).toBe("us-east-1")
  })

  it("falls back to AWS_DEFAULT_REGION before named-profile region", () => {
    expect(
      resolveBedrockRegion(
        {
          AWS_DEFAULT_REGION: "eu-west-1",
          AWS_PROFILE: "bedrock-op",
        },
        {
          readTextFile: () => "[profile bedrock-op]\nregion = ap-southeast-2\n",
        },
      ),
    ).toBe("eu-west-1")
  })

  it("uses the named AWS profile region when env region vars are absent", () => {
    expect(
      resolveBedrockRegion(
        { AWS_PROFILE: "bedrock-op" },
        {
          readTextFile: (path) => {
            expect(path).toContain(".aws")
            return "[profile bedrock-op]\nregion = us-west-2\n"
          },
          homeDirectory: "/tmp/fake-home",
        },
      ),
    ).toBe("us-west-2")
  })

  it("uses the default profile region when AWS_PROFILE is unset", () => {
    expect(
      resolveBedrockRegion(
        {},
        {
          readTextFile: () => "[default]\nregion = ca-central-1\n",
          homeDirectory: "/tmp/fake-home",
        },
      ),
    ).toBe("ca-central-1")
  })

  it("honors AWS_CONFIG_FILE for profile region lookup", () => {
    expect(
      resolveBedrockRegion(
        {
          AWS_PROFILE: "ops",
          AWS_CONFIG_FILE: "/custom/aws/config",
        },
        {
          readTextFile: (path) => {
            expect(path).toBe("/custom/aws/config")
            return "[profile ops]\nregion = sa-east-1\n"
          },
        },
      ),
    ).toBe("sa-east-1")
  })

  it("returns undefined when env and shared config yield no region (SDK fallback path)", () => {
    expect(
      resolveBedrockRegion(
        { AWS_PROFILE: "bedrock-op" },
        {
          readTextFile: () => null,
          homeDirectory: "/tmp/fake-home",
        },
      ),
    ).toBeUndefined()
  })

  it("parses [default] and [profile name] sections from shared config text", () => {
    const config = `
# comment
[default]
region = us-east-1
output = json

[profile bedrock-op]
region = us-west-2
[profile other]
region = eu-west-1
`
    expect(regionFromAwsConfigText(config, "default")).toBe("us-east-1")
    expect(regionFromAwsConfigText(config, "bedrock-op")).toBe("us-west-2")
    expect(regionFromAwsConfigText(config, "missing")).toBeUndefined()
  })

  it("strips quotes and end-of-line comments from profile region values", () => {
    const config = `
[default]
region = "us-east-1" # primary
[profile quoted]
region = 'eu-west-1'
[profile commented]
region = ap-southeast-2 ; trailing
`
    expect(regionFromAwsConfigText(config, "default")).toBe("us-east-1")
    expect(regionFromAwsConfigText(config, "quoted")).toBe("eu-west-1")
    expect(regionFromAwsConfigText(config, "commented")).toBe("ap-southeast-2")
  })
})

describe("scrubBedrockDiscoverySecrets (issue #822)", () => {
  it("redacts access keys, session tokens, and bearer payloads", () => {
    const dirty =
      "failed with AKIAIOSFODNN7EXAMPLE and AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG Bearer abcdefghijklmnop sessionToken=very-secret-session"
    const clean = scrubBedrockDiscoverySecrets(dirty)
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(clean).not.toContain("wJalrXUtnFEMI")
    expect(clean).not.toContain("abcdefghijklmnop")
    expect(clean).not.toContain("very-secret-session")
    expect(clean).toContain("[redacted]")
  })

  it("redacts property-style and JSON secretAccessKey / accessKeyId forms", () => {
    const dirty =
      'sdk error secretAccessKey=supersecretblob AccessKeyId: AKIAIOSFODNN7EXAMPLE {"secretAccessKey":"json-secret","sessionToken":"json-session"}'
    const clean = scrubBedrockDiscoverySecrets(dirty)
    expect(clean).not.toContain("supersecretblob")
    expect(clean).not.toContain("json-secret")
    expect(clean).not.toContain("json-session")
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(clean).toContain("[redacted]")
  })
})

describe("formatBedrockDiscoveryFailure (issue #822)", () => {
  it("maps access denied, credentials, profile, throttle, region, and timeout causes", () => {
    expect(
      formatBedrockDiscoveryFailure({ name: "AccessDeniedException" }),
    ).toContain("access denied")
    expect(
      formatBedrockDiscoveryFailure({ name: "AccessDeniedException" }),
    ).toContain("bedrock:ListInferenceProfiles")
    expect(
      formatBedrockDiscoveryFailure({
        name: "ExpiredTokenException",
        message: "The security token included in the request is expired",
      }),
    ).toContain("credentials")
    expect(
      formatBedrockDiscoveryFailure({
        name: "CredentialsProviderError",
        message: "Could not load credentials from any providers",
      }),
    ).toContain("credentials")
    expect(
      formatBedrockDiscoveryFailure({
        name: "ProfileNotFound",
        message: "Profile bedrock-missing could not be found",
      }),
    ).toContain("named profile")
    expect(
      formatBedrockDiscoveryFailure({
        message: "Could not find credentials for profile bedrock-op",
      }),
    ).toContain("named profile")
    // Inference-profile / IAM instance-profile wording must not be rewritten
    // as AWS_PROFILE guidance.
    const inferenceProfileMiss = formatBedrockDiscoveryFailure({
      name: "ResourceNotFoundException",
      message:
        "Inference profile arn:aws:bedrock:us-west-2:123:inference-profile/x could not be found",
    })
    expect(inferenceProfileMiss).not.toContain("AWS_PROFILE")
    expect(inferenceProfileMiss).not.toContain("named profile")
    const instanceProfileMiss = formatBedrockDiscoveryFailure({
      name: "CredentialsProviderError",
      message: "Instance profile credentials could not be loaded from IMDS",
    })
    expect(instanceProfileMiss).not.toContain("AWS_PROFILE")
    expect(instanceProfileMiss).not.toContain("named profile")
    // Falls through to the general credentials path.
    expect(instanceProfileMiss).toContain("credentials")
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
    expect(
      formatBedrockDiscoveryFailure({
        name: "UnknownError",
        message: "Bedrock service unavailable",
      }),
    ).toContain("Bedrock service unavailable")
    for (const text of [
      formatBedrockDiscoveryFailure({ name: "AccessDeniedException" }),
      formatBedrockDiscoveryFailure({ name: "ThrottlingException" }),
      formatBedrockDiscoveryFailure({ _tag: "TimeoutError" }),
      formatBedrockDiscoveryFailure({
        name: "ProfileNotFound",
        message: "Profile x could not be found",
      }),
    ]) {
      expect(text).toContain("Free-text Agent Model entry remains available")
      // Never embed raw secret-like material from the error path.
      expect(text).not.toMatch(/AKIA|aws_secret|password=/i)
    }
  })

  it("never surfaces access keys or secret payloads from generic control-plane errors", () => {
    const text = formatBedrockDiscoveryFailure({
      name: "Error",
      message:
        "request failed using AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=supersecretvalue AWS_SESSION_TOKEN=sessiontok",
    })
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(text).not.toContain("supersecretvalue")
    expect(text).not.toContain("sessiontok")
    expect(text).toContain("[redacted]")
    expect(text).toContain("Free-text Agent Model entry remains available")
  })
})
