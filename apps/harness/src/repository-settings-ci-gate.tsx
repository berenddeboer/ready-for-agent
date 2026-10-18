import { CI_GATE_DISABLED_LABEL } from "./ci-gate-status-label.js"
import { cx, ui } from "./ui.js"

export const CI_GATE_DEFINITIONS_LOADING_LABEL = "Loading CI Gate Definitions…"
export const CI_GATE_EMPTY_SELECTION_HINT =
  "Selected definitions watch default-branch CI. Empty selection disables the Repository CI Gate."
export const CI_GATE_ON_CLOSE_HEADING = "When the gate closes"
export const CI_GATE_AUTOMATIC_REPAIR_LABEL =
  "Automatically start a CI Repair Work Item"
export const CI_GATE_AUTOMATIC_REPAIR_HINT =
  "A confirmed failure that closes the CI gate queues one repair. Pending CI, Degraded observation, and Paused do not. Manual start and retry stay available."
export const CI_GATE_AUTOMATIC_REPAIR_DISABLED_HINT =
  "Unavailable until a CI Gate Definition is selected. The saved choice is kept."

type AutomaticCiRepairControl = {
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
}

export type CiGateDefinitionChoice = {
  readonly identity: string
  readonly displayLabel: string
  readonly diagnosticMetadata: string | null
}

export type CiGateCatalogView =
  | { readonly kind: "pending" }
  | {
      readonly kind: "error"
      readonly message: string
      readonly persisted: readonly CiGateDefinitionChoice[]
    }
  | {
      readonly kind: "loaded"
      readonly definitions: readonly CiGateDefinitionChoice[]
      readonly unavailable: readonly CiGateDefinitionChoice[]
    }

type RepositoryCiGateStatusView = {
  readonly disabled: boolean
  readonly statusLabel: string
  readonly diagnostic: string | null
  readonly activeIncidentSummary: string | null
  readonly latestResolvedIncidentSummary: string | null
}

export type RepositorySettingsCiGateSectionProps = {
  readonly repositoryId: string
  readonly catalog: CiGateCatalogView
  readonly selectedIdentities: readonly string[]
  readonly onSelectedIdentitiesChange: (identities: string[]) => void
  readonly status: RepositoryCiGateStatusView
  /** Null hides the control. Non-GitHub Repositories do not offer it. */
  readonly automaticCiRepair: AutomaticCiRepairControl | null
}

export const ciGateCatalogViewFromQuery = (input: {
  readonly pending: boolean
  readonly catalog:
    | {
        readonly error: string | null
        readonly definitions: readonly CiGateDefinitionChoice[]
      }
    | undefined
  readonly selectedIdentities: readonly string[]
  readonly savedDefinitions: readonly CiGateDefinitionChoice[]
}): CiGateCatalogView => {
  if (input.pending) {
    return { kind: "pending" }
  }
  const catalog = input.catalog
  if (catalog === undefined) {
    return { kind: "loaded", definitions: [], unavailable: [] }
  }
  if (catalog.error !== null) {
    return {
      kind: "error",
      message: catalog.error,
      persisted: input.savedDefinitions.filter((definition) =>
        input.selectedIdentities.includes(definition.identity),
      ),
    }
  }
  return {
    kind: "loaded",
    definitions: catalog.definitions,
    unavailable: input.savedDefinitions.filter(
      (definition) =>
        input.selectedIdentities.includes(definition.identity) &&
        !catalog.definitions.some(
          (entry) => entry.identity === definition.identity,
        ),
    ),
  }
}

const toggleIdentity = (input: {
  readonly selectedIdentities: readonly string[]
  readonly identity: string
  readonly selected: boolean
}): string[] => {
  if (input.selected) {
    return input.selectedIdentities.includes(input.identity)
      ? [...input.selectedIdentities]
      : [...input.selectedIdentities, input.identity]
  }
  return input.selectedIdentities.filter(
    (identity) => identity !== input.identity,
  )
}

const AutomaticCiRepairSubsection = ({
  repositoryId,
  selectedCount,
  control,
}: {
  repositoryId: string
  selectedCount: number
  control: AutomaticCiRepairControl
}) => {
  const disabled = selectedCount === 0
  const headingId = `repo-ci-gate-on-close-${repositoryId}`
  return (
    <div className={ui.dialogSubsection}>
      <h4 id={headingId} className={ui.dialogSubsectionTitle}>
        {CI_GATE_ON_CLOSE_HEADING}
      </h4>
      <label className={ui.dialogCheck}>
        <input
          type="checkbox"
          className={ui.dialogCheckInput}
          name="automaticCiRepair"
          data-testid="automatic-ci-repair"
          checked={control.checked}
          disabled={disabled}
          onChange={(event) => {
            control.onCheckedChange(event.target.checked)
          }}
        />
        {CI_GATE_AUTOMATIC_REPAIR_LABEL}
        <span className={cx(ui.dialogFieldHint, ui.dialogCheckHint)}>
          {disabled
            ? CI_GATE_AUTOMATIC_REPAIR_DISABLED_HINT
            : CI_GATE_AUTOMATIC_REPAIR_HINT}
        </span>
      </label>
    </div>
  )
}

const DefinitionMetadata = ({ metadata }: { metadata: string | null }) => {
  if (metadata === null || metadata === "") {
    return null
  }
  return (
    <span className={cx(ui.dialogFieldHint, ui.dialogCheckHint)}>
      {metadata}
    </span>
  )
}

const DefinitionCheckbox = ({
  definition,
  checked,
  labelSuffix,
  onToggle,
}: {
  definition: CiGateDefinitionChoice
  checked: boolean
  labelSuffix?: string
  onToggle: (input: { identity: string; selected: boolean }) => void
}) => (
  <label className={ui.dialogCheck}>
    <input
      type="checkbox"
      className={ui.dialogCheckInput}
      name="selectedCiGateDefinitionIdentities"
      value={definition.identity}
      checked={checked}
      onChange={(event) => {
        onToggle({
          identity: definition.identity,
          selected: event.target.checked,
        })
      }}
    />
    {definition.displayLabel}
    {labelSuffix}
    <DefinitionMetadata metadata={definition.diagnosticMetadata} />
  </label>
)

const CatalogBody = ({
  catalog,
  selectedIdentities,
  onToggle,
}: {
  catalog: CiGateCatalogView
  selectedIdentities: readonly string[]
  onToggle: (input: { identity: string; selected: boolean }) => void
}) => {
  switch (catalog.kind) {
    case "pending":
      return (
        <p className={ui.dialogFieldHint}>
          {CI_GATE_DEFINITIONS_LOADING_LABEL}
        </p>
      )
    case "error":
      return (
        <>
          <p className={ui.dialogFieldHint} role="alert">
            {catalog.message}
          </p>
          {catalog.persisted.map((definition) => (
            <DefinitionCheckbox
              key={`persisted-${definition.identity}`}
              definition={definition}
              checked
              onToggle={onToggle}
            />
          ))}
        </>
      )
    case "loaded":
      return (
        <>
          {catalog.definitions.map((definition) => (
            <DefinitionCheckbox
              key={definition.identity}
              definition={definition}
              checked={selectedIdentities.includes(definition.identity)}
              onToggle={onToggle}
            />
          ))}
          {catalog.unavailable.map((definition) => (
            <DefinitionCheckbox
              key={`unavailable-${definition.identity}`}
              definition={definition}
              checked
              labelSuffix=" (unavailable)"
              onToggle={onToggle}
            />
          ))}
        </>
      )
    default: {
      const _exhaustive: never = catalog
      return _exhaustive
    }
  }
}

/**
 * Repository Settings CI Gate section. Catalog discovery is local to this
 * section so Forge latency cannot replace the rest of the dialog.
 */
export function RepositorySettingsCiGateSection({
  repositoryId,
  catalog,
  selectedIdentities,
  onSelectedIdentitiesChange,
  status,
  automaticCiRepair,
}: RepositorySettingsCiGateSectionProps) {
  const onToggle = (input: { identity: string; selected: boolean }) => {
    onSelectedIdentitiesChange(
      toggleIdentity({
        selectedIdentities,
        identity: input.identity,
        selected: input.selected,
      }),
    )
  }

  return (
    <section
      className={ui.dialogSection}
      aria-labelledby={`repo-sec-ci-gate-${repositoryId}`}
    >
      <div className={ui.dialogSectionHead}>
        <h3
          id={`repo-sec-ci-gate-${repositoryId}`}
          className={ui.dialogSectionTitle}
        >
          CI Gate
        </h3>
        <span className={ui.dialogSectionMeta}>Default-branch CI</span>
      </div>
      <CatalogBody
        catalog={catalog}
        selectedIdentities={selectedIdentities}
        onToggle={onToggle}
      />
      <span className={ui.dialogFieldHint}>{CI_GATE_EMPTY_SELECTION_HINT}</span>
      <span className={ui.dialogFieldHint}>
        Current status:{" "}
        {status.disabled ? CI_GATE_DISABLED_LABEL : status.statusLabel}
        {!status.disabled && status.diagnostic !== null
          ? ` — ${status.diagnostic}`
          : ""}
      </span>
      {status.activeIncidentSummary !== null ? (
        <span className={ui.dialogFieldHint}>
          Active incident: {status.activeIncidentSummary}
        </span>
      ) : null}
      {status.latestResolvedIncidentSummary !== null ? (
        <span className={ui.dialogFieldHint}>
          Last resolved: {status.latestResolvedIncidentSummary}
        </span>
      ) : null}
      {automaticCiRepair === null ? null : (
        <AutomaticCiRepairSubsection
          repositoryId={repositoryId}
          selectedCount={selectedIdentities.length}
          control={automaticCiRepair}
        />
      )}
    </section>
  )
}
