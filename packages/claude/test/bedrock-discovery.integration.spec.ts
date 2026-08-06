import { Effect } from "effect"
import {
  discoverBedrockModelsFromAws,
  resolveBedrockRegion,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

/**
 * Opt-in only: never set in CI. Lists Bedrock inference profiles with the
 * bundled AWS SDK using ambient harness credentials/region. Must never invoke
 * a billable model (issue #822).
 *
 * Run with:
 * `BEDROCK_INTEGRATION=1 bun --conditions=@ready-for-agent/source test packages/claude/test/bedrock-discovery.integration.spec.ts`
 */
const runIntegration = process.env.BEDROCK_INTEGRATION === "1"

describe.skipIf(!runIntegration)(
  "Bedrock profile discovery integration (list-only)",
  () => {
    it("lists profiles via AWS SDK without requiring the AWS CLI or InvokeModel", async () => {
      // Ensure we are not about to shell out: discovery is an Effect that uses
      // the in-process Bedrock client. Operators need ambient AWS credentials.
      const environment = process.env as Record<string, string | undefined>
      const region = resolveBedrockRegion(environment)
      // Region may still resolve inside the AWS SDK when undefined here.
      expect(region === undefined || region.length > 0).toBe(true)

      const result = await Effect.runPromise(
        discoverBedrockModelsFromAws({
          environment,
          timeout: "20 seconds",
        }),
      )

      // Discovery is best-effort: either a catalog or an actionable warning.
      expect(Array.isArray(result.models)).toBe(true)
      if (result.warning !== null) {
        expect(result.warning.length).toBeGreaterThan(0)
        expect(result.warning).toContain(
          "Free-text Agent Model entry remains available",
        )
        // Never surface credential material from live AWS errors.
        expect(result.warning).not.toMatch(
          /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|AWS_SECRET_ACCESS_KEY=|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
        )
      }
      for (const model of result.models) {
        expect(model.id.length).toBeGreaterThan(0)
        expect(model.thinkingLevels.length).toBeGreaterThan(0)
        // System-defined IDs or application ARNs only — no floating aliases.
        expect(["haiku", "sonnet", "opus", "fable"]).not.toContain(model.id)
      }
      // This suite must not call bedrock:InvokeModel / InvokeModelWithResponseStream.
      // Listing alone is the only live AWS call exercised here.
    }, 30_000)
  },
)
