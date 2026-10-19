import {
  PROVIDER_RECOVERY_BACKOFF_EXPLANATION,
  PROVIDER_RECOVERY_MAX_WAIT_EXPLANATION,
} from "@ready-for-agent/work-item-lifecycle/provider-recovery-presentation"
import { cx, ui } from "./ui.js"

export function ProviderRecoverySettingsFields({
  mode,
  minutes,
  onModeChange,
  onMinutesChange,
}: {
  readonly mode: "unlimited" | "limited"
  readonly minutes: string
  readonly onModeChange: (mode: "unlimited" | "limited") => void
  readonly onMinutesChange: (minutes: string) => void
}) {
  return (
    <section
      className={ui.dialogSection}
      aria-labelledby="settings-sec-provider"
    >
      <div className={ui.dialogSectionHead}>
        <h3 id="settings-sec-provider" className={ui.dialogSectionTitle}>
          Provider recovery
        </h3>
        <span className={ui.dialogSectionMeta}>Outage wait</span>
      </div>
      <fieldset className={ui.dialogField}>
        <legend className="mb-2">Maximum provider-outage wait</legend>
        <label className={ui.dialogCheck}>
          <input
            className={ui.dialogCheckInput}
            type="radio"
            name="providerRecoveryMaxWaitMode"
            value="unlimited"
            checked={mode === "unlimited"}
            onChange={() => onModeChange("unlimited")}
          />
          Keep retrying
        </label>
        <label className={ui.dialogCheck}>
          <input
            className={ui.dialogCheckInput}
            type="radio"
            name="providerRecoveryMaxWaitMode"
            value="limited"
            checked={mode === "limited"}
            onChange={() => onModeChange("limited")}
          />
          Stop after
          <input
            className={ui.dialogInput}
            name="providerRecoveryMaxWaitMinutes"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            aria-label="Maximum provider-outage wait in minutes"
            value={minutes}
            disabled={mode !== "limited"}
            onChange={(event) => onMinutesChange(event.target.value)}
          />
          minutes
        </label>
        <span className={cx(ui.dialogFieldHint, "mt-2 block")}>
          {PROVIDER_RECOVERY_MAX_WAIT_EXPLANATION}{" "}
          {PROVIDER_RECOVERY_BACKOFF_EXPLANATION}
        </span>
      </fieldset>
    </section>
  )
}
