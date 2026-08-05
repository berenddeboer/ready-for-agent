import { useEffect, useId, useState } from "react"
import type { PipelineLaneId } from "./pipeline-lanes.js"
import { cx, ui } from "./ui.js"

type Dent = {
  readonly id: number
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly rotation: number
  readonly depth: number
  readonly seed: number
}

const RIVET_POSITION_CLASSES = [
  { id: "nw", className: "top-[7px] left-[7px]" },
  { id: "ne", className: "top-[7px] right-[7px]" },
  { id: "sw", className: "bottom-[7px] left-[7px]" },
  { id: "se", className: "right-[7px] bottom-[7px]" },
] as const

const createRandomDents = (): readonly Dent[] => {
  const countRoll = Math.random()
  const count = countRoll < 0.62 ? 0 : countRoll < 0.96 ? 1 : 2
  return Array.from({ length: count }, (_, id) => ({
    id,
    left: 42 + Math.random() * 41,
    top: 20 + Math.random() * 42,
    width: 35 + Math.random() * 23,
    height: 17 + Math.random() * 12,
    rotation: -18 + Math.random() * 36,
    depth: 0.66 + Math.random() * 0.24,
    seed: Math.floor(Math.random() * 9_000) + 1,
  }))
}

function DentMark({ dent }: { readonly dent: Dent }) {
  const id = useId().replaceAll(":", "")
  const fadeId = `dent-fade-${id}`
  const shadeId = `dent-shade-${id}`
  const maskId = `dent-mask-${id}`
  const warpId = `dent-warp-${id}`

  return (
    <svg
      aria-hidden="true"
      data-metal-dent=""
      className={ui.laneHeaderDent}
      viewBox="0 0 100 60"
      style={{
        left: `${dent.left}%`,
        top: `${dent.top}%`,
        width: dent.width,
        height: dent.height,
        opacity: dent.depth,
        transform: `translate(-50%, -50%) rotate(${dent.rotation}deg)`,
      }}
    >
      <defs>
        <radialGradient id={fadeId} cx="50%" cy="50%" rx="50%" ry="50%">
          <stop offset="0" stopColor="white" stopOpacity="0.9" />
          <stop offset="0.52" stopColor="white" stopOpacity="0.78" />
          <stop offset="0.86" stopColor="white" stopOpacity="0.3" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={shadeId} x1="10%" y1="4%" x2="90%" y2="96%">
          <stop offset="0" stopColor="black" stopOpacity="0.58" />
          <stop offset="0.32" stopColor="black" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="white" stopOpacity="0" />
          <stop offset="0.7" stopColor="white" stopOpacity="0.14" />
          <stop offset="1" stopColor="white" stopOpacity="0.62" />
        </linearGradient>
        <mask id={maskId}>
          <ellipse cx="50" cy="30" rx="48" ry="28" fill={`url(#${fadeId})`} />
        </mask>
        <filter id={warpId} x="-25%" y="-40%" width="150%" height="180%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.026 0.07"
            numOctaves="2"
            seed={dent.seed}
            result="warp"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="warp"
            scale="3.5"
            xChannelSelector="R"
            yChannelSelector="B"
            result="warped"
          />
          <feGaussianBlur in="warped" stdDeviation="1.25" />
        </filter>
      </defs>
      <g mask={`url(#${maskId})`} filter={`url(#${warpId})`}>
        <ellipse cx="50" cy="30" rx="48" ry="27" fill={`url(#${shadeId})`} />
      </g>
    </svg>
  )
}

function DentMarks() {
  const [dents, setDents] = useState<readonly Dent[]>([])

  useEffect(() => {
    setDents(createRandomDents())
  }, [])

  return dents.map((dent) => <DentMark dent={dent} key={dent.id} />)
}

function HammeredMetalSurface({ seed }: { readonly seed: number }) {
  const filterId = `hammered-metal-${useId().replaceAll(":", "")}`

  return (
    <svg
      aria-hidden="true"
      className={ui.laneHeaderSurface}
      preserveAspectRatio="none"
    >
      <filter
        id={filterId}
        x="-10%"
        y="-15%"
        width="120%"
        height="130%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="turbulence"
          baseFrequency="0.055 0.095"
          numOctaves="3"
          seed={seed}
          stitchTiles="stitch"
          result="coarse"
        />
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.28 0.38"
          numOctaves="2"
          seed={seed + 67}
          stitchTiles="stitch"
          result="detail"
        />
        <feBlend in="coarse" in2="detail" mode="multiply" result="height" />
        <feGaussianBlur in="height" stdDeviation="0.75" result="soft-height" />
        <feDiffuseLighting
          in="soft-height"
          surfaceScale="3"
          diffuseConstant="0.94"
          lightingColor="#dce3df"
          result="diffuse"
        >
          <feDistantLight azimuth="225" elevation="52" />
        </feDiffuseLighting>
        <feSpecularLighting
          in="soft-height"
          surfaceScale="4.05"
          specularConstant="0.58"
          specularExponent="18"
          lightingColor="#ffffff"
          result="specular"
        >
          <feDistantLight azimuth="225" elevation="58" />
        </feSpecularLighting>
        <feComposite
          in="specular"
          in2="SourceAlpha"
          operator="in"
          result="specular-cut"
        />
        <feBlend in="diffuse" in2="specular-cut" mode="screen" />
      </filter>
      <rect
        width="100%"
        height="100%"
        fill="#7f8783"
        filter={`url(#${filterId})`}
      />
    </svg>
  )
}

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
        <HammeredMetalSurface seed={ordinal * 41 + 69} />
        <span className={ui.laneHeaderInnerEdge} aria-hidden="true" />
        <DentMarks />
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
