import { Data, Duration, Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  buildRunArgs,
  makeOpencodeEnvironment,
} from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { extractOpencodeAssistantText } from "./opencode-output.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

export class DecidePrMergeContextError extends Data.TaggedError(
  "DecidePrMergeContextError",
)<{ readonly message: string }> {}

export class DecidePrMergeOpenCodeError extends Data.TaggedError(
  "DecidePrMergeOpenCodeError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export type DecidePrMergeResult =
  | { readonly _tag: "clanker_merge" }
  | { readonly _tag: "needs_human"; readonly reason: string }

const resolveContext = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new DecidePrMergeContextError({
        message: "Decide PR merge requires a persisted worktree path",
      })
    }
    if (context.sessionId === null || context.sessionId.trim() === "") {
      return yield* new DecidePrMergeContextError({
        message: "Decide PR merge requires the Implement OpenCode Session",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new DecidePrMergeContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    return {
      repository,
      worktreePath: context.worktreePath,
      sessionId: context.sessionId,
    }
  })

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export const parseDecidePrMergeResult = (
  output: string,
): DecidePrMergeResult | null => {
  const lines = output.split("\n").map((line) => line.trim())
  const nonEmptyLines = lines.filter((line) => line !== "")
  const resultLines = lines.filter((line) =>
    /^READY_FOR_AGENT_RESULT:/i.test(line),
  )
  const finalLine = nonEmptyLines.at(-1)

  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0]
  ) {
    return null
  }
  if (/^READY_FOR_AGENT_RESULT:\s*CLANKER_MERGE$/i.test(finalLine)) {
    return { _tag: "clanker_merge" }
  }
  const needsHuman = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*NEEDS_HUMAN\s*:\s*(.+)$/i,
  )
  if (needsHuman?.[1] !== undefined && needsHuman[1].trim() !== "") {
    return { _tag: "needs_human", reason: needsHuman[1].trim().slice(0, 500) }
  }
  return null
}

/**
 * Production Decide PR Merge Lifecycle Step.
 * Continues the Implement OpenCode Session and asks for a risk-based decision:
 * whether a clanker may merge the PR or a human must. Does not merge.
 */
export const decidePrMerge = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, worktreePath, sessionId } =
      yield* resolveContext(context)
    const keymaxxer = yield* KeymaxxerService
    const tokenName = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${repository.githubOwner}/${repository.githubRepo}`,
    })
    if (tokenName === null) {
      return yield* new DecidePrMergeContextError({
        message: `No GitHub credential is configured for ${repository.githubOwner}/${repository.githubRepo}`,
      })
    }
    const prompt = [
      "Assess whether this pull request is low enough risk for an automated agent (clanker) to merge, or whether a human must merge it.",
      "Base the decision on risk: blast radius, security or auth changes, data migrations, irreversible operations, ambiguous requirements, incomplete verification, or anything that needs human judgment.",
      "Inspect the PR and its checks if needed. Do not merge the pull request.",
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: CLANKER_MERGE",
      "or, only when a human must merge:",
      "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
    ].join("\n")
    const args = buildRunArgs({
      prompt,
      cwd: worktreePath,
      model: context.model,
      variant: context.variant,
      sessionId,
    })
    const environment = makeOpencodeEnvironment()
    const command = `${[
      `GH_TOKEN="$${tokenName}"`,
      `GITHUB_TOKEN="$${tokenName}"`,
      `OPENCODE_CONFIG_CONTENT=${shellQuote(environment.OPENCODE_CONFIG_CONTENT)}`,
      shellQuote("opencode"),
      ...args.map(shellQuote),
    ].join(" ")} </dev/null`
    const result = yield* keymaxxer
      .runWithSecrets({
        command,
        cwd: worktreePath,
        secrets: [tokenName],
        timeoutMs: Duration.toMillis(
          context.maxDuration ??
            DEFAULT_LIFECYCLE_MAX_DURATIONS.decide_pr_merge,
        ),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DecidePrMergeOpenCodeError({
              message: "OpenCode failed while deciding PR merge risk",
              cause,
            }),
        ),
      )
    if (result.exitCode !== 0) {
      return yield* new DecidePrMergeOpenCodeError({
        message: "OpenCode failed while deciding PR merge risk",
      })
    }
    const decision = parseDecidePrMergeResult(
      extractOpencodeAssistantText(result.stdout),
    )
    if (decision === null) {
      return yield* new DecidePrMergeOpenCodeError({
        message: "OpenCode did not report CLANKER_MERGE or NEEDS_HUMAN",
      })
    }
    return decision
  })
