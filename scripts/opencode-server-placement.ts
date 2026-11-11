/**
 * Historical `--server` placement versus evidenced acceptance.
 *
 * OpenCode 2.0.32, the baseline pin, rejects `--server` before `run`, `api`,
 * and `session export` (BER-31). Drift run 41303873900 showed 2.2.5 accepts
 * those placements and reaches the no-inference boundary. Local real-binary
 * probes on 2026-11-10 and 2026-11-11 showed the same acceptance for 2.2.6
 * and 2.2.7, installing each as npm latest the way the drift workflow does.
 * A 2.2.0 parser probe also got past flag rejection, but that probe did not
 * prove an isolated server or a stored session, so it is not an accepting
 * contract version and not a cutoff.
 *
 * Do not replace this table with a semver comparison. Required coverage
 * fails closed for an unlisted version. Scheduled drift coverage runs the
 * placement cases as a probe instead: an unlisted version must still reach
 * the same no-inference boundary, and a rejection is upstream drift. A drift
 * pass is not evidence for the table until its version is recorded here.
 */

/** Real-binary evidence that these placements reach the contract boundary. */
export const EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS = [
  "2.2.5",
  "2.2.6",
  "2.2.7",
] as const

export type EvidencedAcceptedServerPlacementVersion =
  (typeof EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS)[number]

/**
 * Exact-version records. 2.2.5 is a GitHub Actions run. 2.2.6 and 2.2.7 are
 * local installer probes recorded in `packages/opencode/CLI-CONTRACT.md`.
 * Drift run 42478079669 installed 2.2.6 but threw before probing, so it is
 * not evidence. Drift run 42825652031 installed 2.2.7 and threw the same way.
 */
export const SERVER_PLACEMENT_EVIDENCE: {
  readonly [Version in EvidencedAcceptedServerPlacementVersion]: string
} = {
  "2.2.5":
    "https://github.com/berenddeboer/ready-for-agent/actions/runs/41303873900",
  "2.2.6":
    "local real-binary probe 2026-11-10: scripts/install-opencode-v2.sh latest installed 2.2.6; production placement cases reached the no-inference boundary (packages/opencode/CLI-CONTRACT.md)",
  "2.2.7":
    "local real-binary probe 2026-11-11: npm latest was 2.2.7; production placement cases reached the no-inference boundary (packages/opencode/CLI-CONTRACT.md)",
}

export type OpenCodeContractMode = "baseline" | "latest"

export type ServerPlacementCapability =
  | { readonly kind: "historical-rejection" }
  | {
      readonly kind: "evidenced-acceptance"
      readonly version: EvidencedAcceptedServerPlacementVersion
    }
  | {
      /**
       * Drift coverage only. The version is not recorded in the table, so
       * the case proves the placement boundary as a probe. Acceptance is a
       * pass, a rejection fails the drift run, and the version still needs
       * an evidence record before it counts as an accepting contract
       * version.
       */
      readonly kind: "unprobed-acceptance"
      readonly version: string
    }

const evidencedAcceptedVersion = (
  version: string,
): EvidencedAcceptedServerPlacementVersion | undefined => {
  for (const candidate of EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS) {
    if (candidate === version) {
      return candidate
    }
  }
  return undefined
}

const acceptanceRecords = (): string =>
  EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS.map(
    (version) =>
      `${version} accepts those placements (${SERVER_PLACEMENT_EVIDENCE[version]})`,
  ).join(". ")

export const serverPlacementCapability = (input: {
  readonly version: string
  readonly baseline: string
  readonly mode?: OpenCodeContractMode
}): ServerPlacementCapability => {
  if (input.version === input.baseline) {
    return { kind: "historical-rejection" }
  }
  const accepted = evidencedAcceptedVersion(input.version)
  if (accepted !== undefined) {
    return {
      kind: "evidenced-acceptance",
      version: accepted,
    }
  }
  if (input.mode === "latest") {
    return { kind: "unprobed-acceptance", version: input.version }
  }
  throw new Error(
    `OpenCode ${input.version} has no evidenced --server placement capability. Baseline ${input.baseline} rejects --server before run, api, and session export. ${acceptanceRecords()}. Refusing to guess a cutoff.`,
  )
}
