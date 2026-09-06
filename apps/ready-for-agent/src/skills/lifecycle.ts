import { Duration } from "effect"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  LIFECYCLE_STEP_AGENT_FREE,
  LIFECYCLE_STEP_RETRYABLE,
  OPERATIONAL_LIFECYCLE_STEPS,
  STEP_RUN_REASONS,
  STEP_RUN_REASON_DEFINITIONS,
  TERMINAL_WORK_ITEM_STATES,
} from "@ready-for-agent/lifecycle-model"

const graphqlState = (notation: string): string => notation.toUpperCase()

const formatDuration = (duration: Duration.Duration): string => {
  const ms = Duration.toMillis(duration)
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`
  }
  return `${ms}ms`
}

const escapeCell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ")

export const renderLifecycleSkill = (version: string): string => {
  const operationalRows = OPERATIONAL_LIFECYCLE_STEPS.map((step) => {
    const agent = LIFECYCLE_STEP_AGENT_FREE[step] ? "no" : "yes"
    const retryable = LIFECYCLE_STEP_RETRYABLE[step] ? "yes" : "no"
    const max = formatDuration(DEFAULT_LIFECYCLE_MAX_DURATIONS[step])
    return `| \`${graphqlState(step)}\` | \`${step}\` | ${agent} | ${retryable} | ${max} |`
  }).join("\n")

  const terminalRows = TERMINAL_WORK_ITEM_STATES.map(
    (state) => `| \`${graphqlState(state)}\` | \`${state}\` |`,
  ).join("\n")

  const reasonRows = STEP_RUN_REASONS.map((reason) => {
    const definition = escapeCell(STEP_RUN_REASON_DEFINITIONS[reason])
    return `| \`${reason}\` | ${definition} |`
  }).join("\n")

  return `# Ready for Agent: lifecycle

Served by ready-for-agent ${version}. Names below are generated from this CLI's ontology. GraphQL and CLI JSON use the uppercase form of each operational/terminal state (\`implement\` → \`IMPLEMENT\`). Step Run reason codes keep the ontology notation (\`handler_failed\`).

Command syntax is not defined here — use \`ready-for-agent --usage\`. If the running Harness \`version\` differs from this CLI, introspect GraphQL; enum values can move between releases.

## Operational states

In GraphQL/CLI JSON these appear as uppercase identifiers. **Agent Turn** steps invoke a coding agent and routinely take minutes to hours.

| GraphQL / CLI | Ontology | Agent Turn | Retryable | Default max |
| --- | --- | --- | --- | --- |
${operationalRows}

## Terminal states

| GraphQL / CLI | Ontology |
| --- | --- |
${terminalRows}

## Step Run reason codes

\`latestStepRunReason.code\` carries one of these.

| Code | Definition |
| --- | --- |
${reasonRows}

Mid-run codes (\`native\`, \`waiting_for_agent_turn\`, \`copy_generation\`, review-progress codes) mean the step is working, not stuck. Load \`recovery\` to map a stop reason to an operator action.
`
}
