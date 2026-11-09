/**
 * Historical `--server` placement versus evidenced acceptance.
 *
 * OpenCode 2.0.32, the baseline pin, rejects `--server` before `run`, `api`,
 * and `session export` (BER-31). Drift run 41303873900 showed 2.2.5 accepts
 * those placements and reaches the no-inference boundary. A local real-binary
 * probe on 2026-11-10, installing 2.2.6 with `scripts/install-opencode-v2.sh
 * latest`, showed the same acceptance through the production placement cases.
 * A 2.2.0 parser probe also got past flag rejection, but that probe did not
 * prove an isolated server or a stored session, so it is not an accepting
 * contract version and not a cutoff.
 *
 * Do not replace this table with a semver comparison. An unlisted version
 * fails closed until a real-binary run records its capability.
 */

/** Real-binary evidence that these placements reach the contract boundary. */
export const EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS = [
  "2.2.5",
  "2.2.6",
] as const

export type EvidencedAcceptedServerPlacementVersion =
  (typeof EVIDENCED_ACCEPTED_SERVER_PLACEMENT_VERSIONS)[number]

/**
 * Exact-version records. 2.2.5 is a GitHub Actions run. 2.2.6 is the local
 * installer probe recorded in `packages/opencode/CLI-CONTRACT.md`. Drift run
 * 42478079669 installed 2.2.6 but threw before probing, so it is not evidence.
 */
export const SERVER_PLACEMENT_EVIDENCE: {
  readonly [Version in EvidencedAcceptedServerPlacementVersion]: string
} = {
  "2.2.5":
    "https://github.com/berenddeboer/ready-for-agent/actions/runs/41303873900",
  "2.2.6":
    "local real-binary probe 2026-11-10: scripts/install-opencode-v2.sh latest installed 2.2.6; production placement cases reached the no-inference boundary (packages/opencode/CLI-CONTRACT.md)",
}

export type ServerPlacementCapability =
  | { readonly kind: "historical-rejection" }
  | {
      readonly kind: "evidenced-acceptance"
      readonly version: EvidencedAcceptedServerPlacementVersion
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
  throw new Error(
    `OpenCode ${input.version} has no evidenced --server placement capability. Baseline ${input.baseline} rejects --server before run, api, and session export. ${acceptanceRecords()}. Refusing to guess a cutoff.`,
  )
}
