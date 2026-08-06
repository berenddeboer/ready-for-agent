import {
  type AgentModelOption,
  formatAgentModelLabel,
} from "./agent-model-settings.js"
import { cx, ui } from "./ui.js"

/**
 * Catalog-only Agent Model control shared by Harness Config and Repository
 * Settings (issue #838). Every Agent Backend renders the same real `<select>`:
 * no editable input, no `<datalist>` suggestions, no free-text entry.
 *
 * A stored value that is absent from the current catalog is preserved as a
 * visibly unavailable synthetic option shown alongside the current catalog, so
 * operators can see what is stored, why it cannot be used, and what they may
 * pick instead. The value is never rewritten or coerced by this component —
 * only an explicit operator choice changes it.
 */

/** Suffix marking a preserved stored value that the catalog no longer lists. */
export const UNAVAILABLE_AGENT_MODEL_SUFFIX = "(not in Agent Model catalog)"

/** Placeholder while the catalog (models query or backend Preview) loads. */
export const AGENT_MODEL_CATALOG_LOADING_LABEL = "Loading catalog…"

export type AgentModelSelectProps = {
  /** Visible field label ("Build model" / "Review model"). */
  readonly label: string
  readonly name: string
  readonly value: string
  readonly onChange: (nextModel: string) => void
  /** Current catalog; `undefined` while it has not loaded. */
  readonly models: readonly AgentModelOption[] | undefined
  readonly catalogLoading: boolean
  /**
   * Whether the empty option stays selectable once a value is set. Optional
   * fields (review model, Repository overrides) keep it so an operator can
   * clear back to the fallback; a required build model does not.
   */
  readonly allowClear: boolean
  readonly required: boolean
  readonly disabled: boolean
  /** Empty-option text when the catalog is usable ("Select a build model"). */
  readonly placeholder: string
  /** Empty-option text when the catalog loaded with no entries. */
  readonly emptyCatalogLabel: string
  /** Operator guidance while this field blocks Save (announced as a status). */
  readonly blockReason: string | null
  /** Steady-state help text, shown only when nothing blocks Save. */
  readonly hint: string | null
  readonly className?: string
}

export function AgentModelSelect(props: AgentModelSelectProps) {
  const catalogLoaded = props.models !== undefined
  const models = props.models ?? []
  const storedValueMissing =
    props.value.length > 0 && !models.some((model) => model.id === props.value)
  return (
    <label className={props.className ?? ui.dialogField}>
      {props.label}
      <select
        className={cx(ui.dialogInput, ui.dialogInputMono)}
        name={props.name}
        value={props.value}
        required={props.required}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {(props.allowClear || props.value.length === 0) && (
          <option value="">
            {props.catalogLoading
              ? AGENT_MODEL_CATALOG_LOADING_LABEL
              : catalogLoaded && models.length === 0
                ? props.emptyCatalogLabel
                : props.placeholder}
          </option>
        )}
        {storedValueMissing && (
          <option value={props.value}>
            {/* Only claim "not in catalog" once a catalog actually loaded —
                a pending catalog must not flash a false unavailable label. */}
            {catalogLoaded && !props.catalogLoading
              ? `${props.value} ${UNAVAILABLE_AGENT_MODEL_SUFFIX}`
              : props.value}
          </option>
        )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {formatAgentModelLabel(model)}
          </option>
        ))}
      </select>
      {props.blockReason !== null ? (
        <span className={ui.dialogFieldHint} role="status">
          {props.blockReason}
        </span>
      ) : props.hint !== null ? (
        <span className={ui.dialogFieldHint}>{props.hint}</span>
      ) : null}
    </label>
  )
}
