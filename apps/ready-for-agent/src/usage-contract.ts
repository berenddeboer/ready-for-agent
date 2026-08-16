import usageSpec from "../ready-for-agent.usage.kdl" with { type: "text" }

/** Exact root metadata switch. Hidden from docs and completions. */
const USAGE_METADATA_SWITCH = "--usage"

export const isExactUsageMetadataInvocation = (
  userArgs: readonly string[],
): boolean => userArgs.length === 1 && userArgs[0] === USAGE_METADATA_SWITCH

/** Checked-in Usage KDL with exactly one trailing newline. */
export const usageContractText = (): string =>
  usageSpec.endsWith("\n") ? usageSpec : `${usageSpec}\n`
