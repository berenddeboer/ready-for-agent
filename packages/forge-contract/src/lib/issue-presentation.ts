import { Effect } from "effect"
import type { Forge } from "@ready-for-agent/lifecycle-model"
import type { ResolvedForgePullRequestMutations } from "./mutation.js"
import type { ForgeRepository } from "./types.js"

/**
 * Identity a prompt or publication path uses to name one Issue on one
 * Repository. Numbers stay the existing positive integer Issue number.
 */
export type ForgeIssueIdentity = {
  readonly forge: Forge
  readonly forgeHost: string
  readonly projectPath: string
  readonly issueNumber: number
}

/**
 * How Create PR associates an Issue with a pull/merge request after the
 * open identity is known. GitHub and GitLab rely on the textual closing
 * reference already in publication copy. Azure writes an ArtifactLink in
 * addition; that write is not a textual `Closes #N` mention.
 */
export type ForgeNativePullRequestAssociation =
  | { readonly kind: "closing_reference" }
  | { readonly kind: "azure_artifact_link" }

/**
 * Closing-reference and placeholder rules used by publication copy.
 * All three current Forges persist `Closes #<n>` today, including Azure.
 */
export type ForgeClosingReferenceRules = {
  readonly formatLine: (issueNumber: number) => string
  readonly strip: (body: string, issueNumber: number) => string
  readonly isGenericPlaceholder: (body: string) => boolean
  readonly genericPlaceholderExample: string
  readonly genericPlaceholderBody: (issueNumber: number) => string
  readonly mentionGuidance: (issueNumber: number) => string
  readonly commitMustCloseGuidance: (issueNumber: number) => string
}

/**
 * Existing Forge-specific Issue identity text, read/state-change guidance,
 * publication closing-reference rules, and native PR association. Callers
 * must not infer these from Forge names.
 */
export type ResolvedForgeIssuePresentation = {
  readonly forge: Forge
  readonly identityText: string
  readonly issueNoun: string
  readonly stayOpenGuidance: string
  readonly includeCredentialGuidance: boolean
  readonly implementAccessScope: string
  readonly nativeCreateAccessScope: string
  readonly closingReference: ForgeClosingReferenceRules
  readonly nativePullRequestAssociation: ForgeNativePullRequestAssociation
}

const forgeDisplayName = (forge: Forge): string => {
  switch (forge) {
    case "github":
      return "GitHub"
    case "gitlab":
      return "GitLab"
    case "azure-devops":
      return "Azure DevOps"
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

/**
 * Closing-reference patterns the harness normalizes to a single
 * `Closes #<n>` line (issue keywords GitHub recognizes). All three current
 * Forges share this stripping today.
 */
const CLOSING_REFERENCE_LINE =
  /^(?:[-*]\s+)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\s*[.:]?\s*$/i

const GENERIC_PLACEHOLDER_BODY =
  /^Automated draft pull request for GitHub issue #\d+\.?$/i

const formatClosingReferenceLine = (issueNumber: number): string =>
  `Closes #${issueNumber}`

const stripClosingReferences = (body: string, issueNumber: number): string => {
  const kept: string[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    const match = CLOSING_REFERENCE_LINE.exec(trimmed)
    if (match !== null && Number(match[1]) === issueNumber) {
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop()
  }
  return kept.join("\n").trim()
}

const genericPlaceholderBody = (issueNumber: number): string =>
  `Automated draft pull request for GitHub issue #${issueNumber}.`

/**
 * Today's shared native closing-reference rules. GitHub, GitLab, and Azure
 * DevOps all persist `Closes #<n>` and reject the GitHub-worded generic
 * placeholder; Azure association is a separate ArtifactLink write.
 */
export const currentNativeForgeClosingReferenceRules: ForgeClosingReferenceRules =
  {
    formatLine: formatClosingReferenceLine,
    strip: stripClosingReferences,
    isGenericPlaceholder: (body) => GENERIC_PLACEHOLDER_BODY.test(body),
    genericPlaceholderExample:
      "Automated draft pull request for GitHub issue #N",
    genericPlaceholderBody,
    mentionGuidance: (issueNumber) =>
      `You may mention issue #${issueNumber}; the harness will ensure the body ends with exactly one Closes #${issueNumber} reference.`,
    commitMustCloseGuidance: (issueNumber) =>
      `The commit must still close GitHub issue #${issueNumber} (include Closes #${issueNumber} in the body unless policy forbids it — then mention the issue another accepted way).`,
  }

const closingReferenceRulesForForge = (
  forge: Forge,
): ForgeClosingReferenceRules => {
  switch (forge) {
    case "github":
    case "gitlab":
    case "azure-devops":
      return currentNativeForgeClosingReferenceRules
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const nativePullRequestAssociationForForge = (
  forge: Forge,
): ForgeNativePullRequestAssociation => {
  switch (forge) {
    case "github":
    case "gitlab":
      return { kind: "closing_reference" }
    case "azure-devops":
      return { kind: "azure_artifact_link" }
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const identityTextFor = (identity: ForgeIssueIdentity): string => {
  const displayName = forgeDisplayName(identity.forge)
  const numbered = `${identity.projectPath}#${identity.issueNumber}`
  switch (identity.forge) {
    case "github":
      return `${displayName} issue ${numbered}`
    case "gitlab":
    case "azure-devops":
      return `${displayName} issue ${numbered} on ${identity.forgeHost}`
    default: {
      const _exhaustive: never = identity.forge
      return _exhaustive
    }
  }
}

const stayOpenGuidanceFor = (forge: Forge): string => {
  const leaveOpen =
    "Leave the tracker Issue open; the harness closes it after merge."
  switch (forge) {
    case "github":
      return `${leaveOpen} Do not close, complete, or change its state, including \`gh issue close\`.`
    case "gitlab":
      return `${leaveOpen} Do not close, complete, or change its state, including \`glab issue close\` or an API state change.`
    case "azure-devops":
      return `${leaveOpen} You may GET the Work Item to inspect it. Do not close, complete, or change its state, including PATCH of \`System.State\`.`
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const implementAccessScopeFor = (forge: Forge): string => {
  switch (forge) {
    case "github":
      return "read of the GitHub Issue"
    case "gitlab":
      return "read of the GitLab Issue"
    case "azure-devops":
      return "read of the Azure DevOps Issue"
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const nativeCreateAccessScopeFor = (forge: Forge): string => {
  switch (forge) {
    case "github":
      return "GitHub CLI or API access"
    case "gitlab":
      return "GitLab API or push access"
    case "azure-devops":
      return "Azure DevOps API or push access"
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const includeCredentialGuidanceFor = (forge: Forge): boolean => {
  switch (forge) {
    case "github":
      return false
    case "gitlab":
    case "azure-devops":
      return true
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

/**
 * Resolve existing Issue presentation and native PR-linking rules for one
 * Forge identity. GitHub stays ambient (no host in identity, no Implement
 * credential line); GitLab and Azure DevOps name the host.
 */
export const resolveForgeIssuePresentation = (
  identity: ForgeIssueIdentity,
): ResolvedForgeIssuePresentation => ({
  forge: identity.forge,
  identityText: identityTextFor(identity),
  issueNoun: `${forgeDisplayName(identity.forge)} Issue`,
  stayOpenGuidance: stayOpenGuidanceFor(identity.forge),
  includeCredentialGuidance: includeCredentialGuidanceFor(identity.forge),
  implementAccessScope: implementAccessScopeFor(identity.forge),
  nativeCreateAccessScope: nativeCreateAccessScopeFor(identity.forge),
  closingReference: closingReferenceRulesForForge(identity.forge),
  nativePullRequestAssociation: nativePullRequestAssociationForForge(
    identity.forge,
  ),
})

/**
 * Apply the existing native PR↔Issue association after Create PR has an
 * open pull/merge request identity. GitHub and GitLab are no-ops (copy
 * already carries `Closes #N`). Azure writes the ArtifactLink with today's
 * identity and timing; retries and reused PRs call this again because the
 * write is idempotent.
 */
export const associateNativePullRequestWithIssue = <E>(input: {
  readonly mutations: ResolvedForgePullRequestMutations<E>
  readonly repository: ForgeRepository
  readonly pullRequestNumber: number
  readonly issueNumber: number
}): Effect.Effect<void, E> => {
  switch (input.mutations.forge) {
    case "github":
    case "gitlab":
      return Effect.void
    case "azure-devops":
      return input.mutations.ensurePullRequestLinkedToIssue(
        input.repository,
        input.pullRequestNumber,
        input.issueNumber,
      )
    default: {
      const _exhaustive: never = input.mutations
      return _exhaustive
    }
  }
}
