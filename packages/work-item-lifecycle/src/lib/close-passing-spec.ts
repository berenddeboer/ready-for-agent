import { createHash } from "node:crypto"
import { Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { specHierarchyFingerprint } from "@ready-for-agent/forge-contract"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  LinearNotConfiguredError,
  LinearService,
} from "@ready-for-agent/linear-service"
import { LifecycleStepFailedError } from "./errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import type { SpecValidationInput } from "./validate-spec.js"

export const closePassingSpec = Effect.fn("closePassingSpec")(function* (
  context: LifecycleStepContext,
  input: SpecValidationInput,
) {
  const summary = context.completionSummary
  if (!summary?.trim()) {
    return yield* new LifecycleStepFailedError({
      message: "Spec close-out requires a persisted passing evidence summary.",
    })
  }
  const db = yield* DbService
  const repository = (yield* db.listRepositories).find(
    ({ id }) => id === context.repositoryId,
  )
  if (!repository || repository.paused) return "waiting"

  // An attempt keeps the same marker across ambiguous writes and restarts.
  // Fresh evidence after a changed hierarchy is a different verdict.
  const guard = {
    hierarchyFingerprint: specHierarchyFingerprint(input.descendants),
    // Older frozen inputs predate the reopening anchor. A tracked reopening
    // therefore invalidates their pass instead of letting it close a new opening.
    parentReopenEventId: input.parentReopenEventId ?? null,
  }
  const hash = createHash("sha256")
    .update(JSON.stringify([summary, guard]))
    .digest("hex")
  const verdictId = `${context.workItemId}:${hash}`
  const markdown = `## Spec validation: passed\n\n${summary}`
  if (input.spec.tracker === "github") {
    const github = yield* GitHubService
    if (github.closePassingSpec) {
      return yield* github.closePassingSpec(
        {
          forge: "github",
          forgeHost: repository.forgeHost,
          projectPath: repository.projectPath,
        },
        Number(input.spec.nativeId),
        verdictId,
        markdown,
        guard,
      )
    }
  } else {
    const linear = yield* LinearService
    if (linear.closePassingSpec) {
      const nativeId = input.spec.nativeId
      const issue = yield* linear.getIssue(nativeId)
      const config = repository.linearWorkflowStatuses.find(
        ({ teamId }) => teamId === issue.teamId,
      )
      if (!config) {
        return yield* new LinearNotConfiguredError({
          repositoryId: repository.id,
          message: `No Done workflow status is configured for Linear team ${issue.teamKey}. Choose Done in Repository settings, then Retry.`,
        })
      }
      return yield* linear.closePassingSpec({
        nativeId,
        doneStateId: config.doneStateId,
        verdictId,
        summary: markdown,
        guard,
      })
    }
  }
  return yield* new LifecycleStepFailedError({
    message: `Spec close-out is unavailable on this ${input.spec.tracker} connection.`,
  })
})
