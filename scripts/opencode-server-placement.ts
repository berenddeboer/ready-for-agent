/**
 * Historical `--server` placement versus evidenced acceptance.
 *
 * OpenCode 2.0.32, the baseline pin, rejects `--server` before `run`, `api`,
 * and `session export` (BER-31). Drift run 41303873900 showed 2.2.5 accepts
 * those placements and reaches the no-inference boundary. A 2.2.0 parser
 * probe also got past flag rejection, but that probe did not prove an
 * isolated server or a stored session, so it is not an accepting contract
 * version and not a cutoff.
 *
 * Do not replace this table with a semver comparison. An unlisted version
 * fails closed until a real-binary run records its capability.
 */

/** Real-binary evidence that these placements reach the contract boundary. */
export const EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSION = "2.2.5"

export const SERVER_PLACEMENT_EVIDENCE_RUN =
  "https://github.com/berenddeboer/ready-for-agent/actions/runs/41303873900"

export type ServerPlacementCapability =
  | { readonly kind: "historical-rejection" }
  | {
      readonly kind: "evidenced-acceptance"
      readonly version: typeof EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSION
    }

export const serverPlacementCapability = (input: {
  readonly version: string
  readonly baseline: string
}): ServerPlacementCapability => {
  if (input.version === input.baseline) {
    return { kind: "historical-rejection" }
  }
  if (input.version === EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSION) {
    return {
      kind: "evidenced-acceptance",
      version: EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSION,
    }
  }
  throw new Error(
    `OpenCode ${input.version} has no evidenced --server placement capability. Baseline ${input.baseline} rejects --server before run, api, and session export. ${EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSION} accepts those placements (${SERVER_PLACEMENT_EVIDENCE_RUN}). Refusing to guess a cutoff.`,
  )
}
