import type { Effect } from "effect"
import type {
  CiGateCatalogEntry,
  CiGateObservation,
  ForgeRepository,
  ObserveCiGateInput,
  PrStatusCheckDiagnostic,
  PrStatusCheckDiagnosticsOptions,
  PrStatusCheckDiagnosticsRequest,
  PullRequestCheckStatus,
  PullRequestLifecycleStatus,
} from "./types.js"

/**
 * Semantic source used to order GitHub API operations. GitLab and Azure
 * DevOps ignore it. Callers express why the operation is happening; GitHub
 * owns scheduling policy.
 */
export type ForgeOperationOrigin =
  | "operator"
  | "lifecycle"
  | "polling"
  | "background"

export interface ForgeOperationOptions {
  readonly origin: ForgeOperationOrigin
}

/**
 * Branch-to-PR lookups, lifecycle status, PR Status Checks, diagnostics,
 * and open non-draft counts. Hard lookup fails when no open PR exists;
 * nullable lookup returns null. Branch matching is exact.
 */
export interface ForgePullRequestObservation<E = unknown> {
  /**
   * Hard lookup of an open pull/merge request for the exact head/source
   * branch. Fails when no open pull request exists.
   */
  readonly getOpenPullRequestNumber: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<number, E>
  /**
   * Soft lookup of an open pull/merge request for the exact head/source
   * branch. Returns null when none exists (does not fail).
   */
  readonly findOpenPullRequestNumber: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<number | null, E>
  /**
   * Lifecycle state of the pull/merge request on a head/source branch, or
   * not found. Used to detect harness or external merge/close outcomes.
   */
  readonly getPullRequestLifecycleStatus: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestLifecycleStatus, E>
  /**
   * Observe PR Status Checks for the open pull/merge request on the exact
   * head/source branch, including mergeability and draft/head metadata.
   */
  readonly getPullRequestCheckStatus: (
    repository: ForgeRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestCheckStatus, E>
  /**
   * Load harness diagnostics for red PR Status Checks. GitHub prefers
   * Actions job logs and treats Checks API 403 as non-fatal when an Actions
   * identity is available.
   */
  readonly getPrStatusCheckDiagnostics: (
    repository: ForgeRepository,
    checks: readonly PrStatusCheckDiagnosticsRequest[],
    options?: PrStatusCheckDiagnosticsOptions,
  ) => Effect.Effect<readonly PrStatusCheckDiagnostic[], E>
  /**
   * Count currently open, non-draft pull/merge requests. Azure DevOps is
   * not implemented and fails with its not-implemented error.
   */
  readonly countOpenNonDraftPullRequests: (
    repository: ForgeRepository,
  ) => Effect.Effect<number, E>
}

/**
 * Live Repository CI Gate catalog and default-branch observation.
 * `origin` is honored only by GitHub's operation coordinator.
 */
export interface ForgeRepositoryCiObservation<E = unknown> {
  /**
   * Live catalog of CI Gate Definitions for the Repository. Empty when the
   * provider has nothing selectable.
   */
  readonly listCiGateCatalog: (
    repository: ForgeRepository,
    options?: ForgeOperationOptions,
  ) => Effect.Effect<readonly CiGateCatalogEntry[], E>
  /**
   * Observe selected CI Gate Definitions on the current default branch.
   * Provider order and raw status/conclusion are preserved. Pull Request
   * validation executions are omitted.
   */
  readonly observeCiGate: (
    repository: ForgeRepository,
    input: ObserveCiGateInput,
    options?: ForgeOperationOptions,
  ) => Effect.Effect<CiGateObservation, E>
}

/**
 * Provider-neutral internal view of existing Forge PR and Repository CI
 * observation operations. Not an independently selected tracker.
 */
export type ForgeObservation<E = unknown> = ForgePullRequestObservation<E> &
  ForgeRepositoryCiObservation<E>
