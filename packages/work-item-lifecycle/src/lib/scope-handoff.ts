import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { promptUserContentSection } from "./sanitize-prompt-user-content.js"

/** Kept with the worktree across Retry and compaction; excluded from publication. */
export const scopeHandoffPath = (worktreePath: string): string =>
  join(worktreePath, ".ready-for-agent", "scope.md")

/** Reload on every substantive turn so operator amendments do not become stale. */
export const loadScopeHandoff = (
  context: LifecycleStepContext,
  worktreePath: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = scopeHandoffPath(worktreePath)
    if (!(yield* fs.exists(path))) {
      yield* fs.makeDirectory(join(worktreePath, ".ready-for-agent"), {
        recursive: true,
      })
      yield* fs.writeFileString(
        path,
        [
          `# Scope for Work Item ${context.workItemId}`,
          `Issue: ${context.issueSource?.url ?? `${context.repositoryId}#${context.issueNumber}`}`,
          "",
          "## Agreed requirements",
          "Not yet summarized. Read the Issue and explicit operator decisions in this Session.",
          "",
          "## Operator amendments and accepted limitations",
          "None recorded yet; this does not mean none exist in the Session.",
          "",
          "## Deferred work",
          "Record explicit exclusions with their source and any follow-up Issue.",
          "",
        ].join("\n"),
      )
    }
    const contents = yield* fs.readFileString(path)
    return [
      "## Scope handoff",
      `Durable scope file: ${path}`,
      "Before implementing, reviewing, or delegating, reconcile this handoff with the Issue and the latest explicit operator decisions in this Session. Update only this scope file to record the agreed requirements, amendments, accepted limitations, and deferred work with source quotes or references.",
      "Explicit operator amendments override the original Issue where they conflict. Agent suggestions and review findings are not operator approval to change scope. Preserve decisions across retries; never infer acceptance from silence. If a material conflict cannot be resolved from those sources, request a scope decision instead of inventing one.",
      "Pass the complete reconciled scope handoff to every delegated agent, including reviewers; an Issue link alone is insufficient. Keep it current when the operator changes scope, before returning or compacting the Session.",
      promptUserContentSection("scope_handoff", contents),
    ].join("\n")
  })
