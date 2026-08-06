import { ui } from "./ui.js"

/**
 * Non-fatal Agent Backend warnings (Bedrock discovery guidance, …) rendered as
 * `role="status"` lines. Shared by Harness Config Active status, Harness Config
 * backend Preview status, and Repository Settings backend Preview status so all
 * three keep one accessible warning presentation (#830).
 *
 * Readability is theme-driven via `ui.dialogStatusWarning` — a Tailwind `dark:`
 * variant would follow the browser/OS preference instead of the visible Harness
 * surface and paint pale text on a light status row.
 */
export function AgentBackendWarnings({
  warnings,
}: {
  warnings: readonly string[]
}) {
  return (
    <>
      {warnings.map((warning) => (
        <p key={warning} className={ui.dialogStatusWarning} role="status">
          {warning}
        </p>
      ))}
    </>
  )
}
