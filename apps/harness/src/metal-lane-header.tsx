import type { PipelineLaneId } from "./pipeline-lanes.js"
import { cx, ui } from "./ui.js"

const RIVET_POSITION_CLASSES = [
  { id: "nw", className: "top-[7px] left-[7px]" },
  { id: "ne", className: "top-[7px] right-[7px]" },
  { id: "sw", className: "bottom-[7px] left-[7px]" },
  { id: "se", className: "right-[7px] bottom-[7px]" },
] as const

export function MetalLaneHeader({
  laneId,
  label,
  titleId,
  ordinal,
}: {
  readonly laneId: PipelineLaneId
  readonly label: string
  readonly titleId: string
  readonly ordinal: number
}) {
  return (
    <header className={ui.laneHeader} data-lane={laneId}>
      <div className={ui.laneHeaderSheet}>
        <span className={ui.laneHeaderGrain} aria-hidden="true" />
        {RIVET_POSITION_CLASSES.map((rivet) => (
          <span
            aria-hidden="true"
            className={cx(ui.laneHeaderRivet, rivet.className)}
            key={rivet.id}
          />
        ))}
        <span className={ui.laneHeaderCode} aria-hidden="true">
          RFA / {String(ordinal).padStart(2, "0")}
        </span>
        <h3 className={ui.laneTitle} id={titleId}>
          {label}
        </h3>
      </div>
    </header>
  )
}
