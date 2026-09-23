import { Context, type Effect } from "effect"
import type { FpRequestError } from "./errors.js"
import type {
  FpIssue,
  FpIssueSnapshot,
  FpProjectOptions,
  FpReadiness,
} from "./types.js"

export type FpServiceError = FpRequestError

/**
 * fp (Fiberplane's local-first tracker) as an Issue Tracker. Every operation
 * runs the fp CLI with the project directory as working directory: the CLI
 * is fp's supported local interface (its REST mode is for sandboxes and CI
 * against a linked project, not a documented API), and the harness holds no
 * credential of its own; the operator's fp login on the machine is the
 * identity.
 */
export interface FpServiceShape {
  /**
   * The operator's fp identity: the authenticated account's email, which is
   * also what fp records as an Issue's author.
   */
  readonly getAuthenticatedUserLogin: (
    projectDirectory: string,
  ) => Effect.Effect<string, FpServiceError>
  /**
   * Open Ready-labeled Issues of one fp project with parent, children,
   * and dependency facts. fp's list output carries no labels, so each
   * candidate is inspected with `fp issue show`; results are cached by
   * `updatedAt` between calls so a poll re-reads only what changed.
   */
  readonly listReadyIssues: (
    options: FpProjectOptions,
  ) => Effect.Effect<readonly FpIssue[], FpServiceError>
  /**
   * Live status and labels of one Issue, by Issue Native Identity or Issue
   * Display Identifier (fp accepts both). Uses the project's closed statuses.
   */
  readonly getIssue: (
    options: FpProjectOptions,
    issueId: string,
  ) => Effect.Effect<FpIssueSnapshot, FpServiceError>
  /** The CLI is on the path and the directory resolves to an fp project. */
  readonly checkReadiness: (
    projectDirectory: string,
  ) => Effect.Effect<FpReadiness>
}

export class FpService extends Context.Service<FpService, FpServiceShape>()(
  "@ready-for-agent/fp-service/FpService",
) {}
