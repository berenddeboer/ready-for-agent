import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import type { ForgeRepository } from "@ready-for-agent/forge-contract"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"

export class CiRepairRerunError extends Schema.TaggedError<CiRepairRerunError>()(
  "CiRepairRerunError",
  {
    message: Schema.String,
  },
) {}

/**
 * Positive integer run id: the prefix before the first colon.
 * `123`, `123:2`, and `123:attempt` are run 123. Non-integers and
 * non-positive prefixes are rejected.
 */
export const ciRepairRunIdFromIdentity = (
  runIdentity: string,
): number | null => {
  const separator = runIdentity.indexOf(":")
  const prefix = (
    separator === -1 ? runIdentity : runIdentity.slice(0, separator)
  ).trim()
  if (!/^[0-9]+$/.test(prefix)) {
    return null
  }
  const id = Number(prefix)
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null
  }
  return id
}

/**
 * Drop blank and duplicate identities. Identities that name the same
 * numeric run (`id` and `id:attempt`) rerun once; the API retries the run,
 * not one attempt.
 */
export const dedupeCiRepairRunIdentities = (
  identities: readonly string[],
): readonly string[] => {
  const seenIdentities = new Set<string>()
  const seenIds = new Set<number>()
  const result: string[] = []
  for (const identity of identities) {
    const trimmed = identity.trim()
    if (trimmed === "" || seenIdentities.has(trimmed)) {
      continue
    }
    seenIdentities.add(trimmed)
    const runId = ciRepairRunIdFromIdentity(trimmed)
    if (runId !== null) {
      if (seenIds.has(runId)) {
        continue
      }
      seenIds.add(runId)
    }
    result.push(trimmed)
  }
  return result
}

const causeMessage = (cause: unknown): string => {
  if (cause instanceof CiRepairRerunError) {
    return cause.message
  }
  if (typeof cause === "string" && cause.trim() !== "") {
    return cause.trim()
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim() !== ""
  ) {
    return cause.message.trim()
  }
  return "CI job rerun failed"
}

const CANNOT_RERUN = "This Forge cannot rerun CI jobs"

type ForgeRunRerun = (
  repository: ForgeRepository,
  runId: number,
) => Effect.Effect<void, unknown>

/** Live GitLab/Azure services keep these methods off the Shape. */
const optionalRerun = (
  service: object,
  method: "retryPipeline" | "retryBuild",
): ForgeRunRerun | undefined => {
  const candidate = (service as Record<string, unknown>)[method]
  return typeof candidate === "function"
    ? (candidate as ForgeRunRerun)
    : undefined
}

const rerunFailure = (identity: string, cause: unknown) =>
  new CiRepairRerunError({
    message: `Failed to rerun CI run ${identity}: ${causeMessage(cause)}`,
  })

/**
 * Rerun each named CI run before a CI Repair No-Change Outcome succeeds.
 * GitHub uses `GitHubService.rerunWorkflowRun`. GitLab and Azure DevOps
 * call `retryPipeline` / `retryBuild`, which stay off the service Shape.
 * Harness ambient and Keymaxxer layers attach those methods (vault helpers
 * or the live service). A stub that does not attach one fails the step.
 */
export const rerunCiRepairJobs = (
  context: { readonly repositoryId: string },
  runIdentities: readonly string[],
): Effect.Effect<
  void,
  CiRepairRerunError,
  DbService | GitHubService | GitLabService | AzureDevOpsService
> =>
  Effect.gen(function* () {
    const identities = dedupeCiRepairRunIdentities(runIdentities)
    if (identities.length === 0) {
      return yield* new CiRepairRerunError({
        message: "CI Repair rerun requires at least one run identity",
      })
    }

    const runs: { readonly identity: string; readonly runId: number }[] = []
    for (const identity of identities) {
      const runId = ciRepairRunIdFromIdentity(identity)
      if (runId === null) {
        return yield* new CiRepairRerunError({
          message: `Invalid CI run identity ${identity}: expected a positive integer id before the first colon`,
        })
      }
      runs.push({ identity, runId })
    }

    const db = yield* DbService
    const repositories = yield* db.listRepositories.pipe(
      Effect.mapError(
        (cause) =>
          new CiRepairRerunError({
            message: `Failed to resolve the repository for a CI job rerun: ${causeMessage(cause)}`,
          }),
      ),
    )
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new CiRepairRerunError({
        message: `Repository ${context.repositoryId} was not found for a CI job rerun`,
      })
    }
    const forgeRepository: ForgeRepository = {
      forge: repository.forge,
      forgeHost: repository.forgeHost,
      projectPath: repository.projectPath,
    }

    for (const run of runs) {
      switch (repository.forge) {
        case "github": {
          const github = yield* GitHubService
          yield* github
            .rerunWorkflowRun(forgeRepository, run.runId)
            .pipe(Effect.mapError((cause) => rerunFailure(run.identity, cause)))
          break
        }
        case "gitlab": {
          const gitlab = yield* GitLabService
          const retryPipeline = optionalRerun(gitlab, "retryPipeline")
          if (retryPipeline === undefined) {
            return yield* new CiRepairRerunError({
              message: `${CANNOT_RERUN} (gitlab)`,
            })
          }
          yield* retryPipeline(forgeRepository, run.runId).pipe(
            Effect.mapError((cause) => rerunFailure(run.identity, cause)),
          )
          break
        }
        case "azure-devops": {
          const azureDevOps = yield* AzureDevOpsService
          const retryBuild = optionalRerun(azureDevOps, "retryBuild")
          if (retryBuild === undefined) {
            return yield* new CiRepairRerunError({
              message: `${CANNOT_RERUN} (azure-devops)`,
            })
          }
          yield* retryBuild(forgeRepository, run.runId).pipe(
            Effect.mapError((cause) => rerunFailure(run.identity, cause)),
          )
          break
        }
        default: {
          const _exhaustive: never = repository.forge
          return yield* new CiRepairRerunError({
            message: `${CANNOT_RERUN} (${String(_exhaustive)})`,
          })
        }
      }
    }
  })
