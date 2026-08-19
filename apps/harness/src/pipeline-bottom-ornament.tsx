import { ui } from "./ui.js"

/** Decorative locomotive terminus beneath the six-lane pipeline. */
export function PipelineBottomOrnament() {
  return (
    <div className={ui.pipelineBottomOrnament} aria-hidden="true">
      <svg
        className={ui.pipelineBottomOrnamentSvg}
        aria-hidden="true"
        viewBox="0 0 1440 154"
      >
        <defs>
          <linearGradient id="rail-steel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#58615e" />
            <stop offset="0.35" stopColor="#252a28" />
            <stop offset="1" stopColor="#090b0a" />
          </linearGradient>
          <linearGradient id="rail-brass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e2bf6d" />
            <stop offset="0.5" stopColor="#956c27" />
            <stop offset="1" stopColor="#49300e" />
          </linearGradient>
        </defs>
        <path
          fill="url(#rail-steel)"
          stroke="#090b0a"
          strokeWidth="4"
          d="M0 2h1440v20H0z"
        />
        <g
          className={ui.pipelineBottomOrnamentTruss}
          fill="none"
          stroke="#151817"
          strokeWidth="8"
          strokeLinejoin="round"
        >
          <path d="M0 20h1440M0 140h1440M0 20l120 120L240 20l120 120L480 20l120 120L720 20l120 120L960 20l120 120 120-120 120 120 120-120" />
        </g>
        <g fill="url(#rail-brass)" stroke="#090b0a" strokeWidth="3">
          <circle cx="120" cy="140" r="12" />
          <circle cx="360" cy="140" r="12" />
          <circle cx="1080" cy="140" r="12" />
          <circle cx="1320" cy="140" r="12" />
        </g>
        <g transform="translate(720 85)">
          <path
            fill="#111412"
            stroke="#090b0a"
            strokeWidth="5"
            d="M-150-63h300v121h-300z"
          />
          <path
            fill="url(#rail-steel)"
            stroke="#090b0a"
            strokeWidth="4"
            d="M-132-48h264v89h-264z"
          />
          <path
            fill="none"
            stroke="url(#rail-brass)"
            strokeWidth="7"
            d="M-105 25V-8c0-31 22-49 49-49h112c27 0 49 18 49 49v33"
          />
          <path
            fill="#090b0a"
            stroke="#090b0a"
            strokeWidth="3"
            d="M-170 58 0 12l170 46Z"
          />
          <path
            fill="none"
            stroke="url(#rail-brass)"
            strokeWidth="5"
            d="M-155 52 0 19l155 33M-115 58 0 26l115 32M-68 58 0 34l68 24"
          />
          <circle
            cy="-6"
            r="39"
            fill="#161a18"
            stroke="url(#rail-brass)"
            strokeWidth="8"
          />
          <circle
            cy="-6"
            r="24"
            fill="#f1d890"
            stroke="#090b0a"
            strokeWidth="3"
          />
          <path d="M-11-16 13-6-11 4Z" fill="#151515" />
          <rect
            x="-45"
            y="-79"
            width="90"
            height="18"
            rx="2"
            fill="url(#rail-brass)"
            stroke="#090b0a"
            strokeWidth="3"
          />
          <text
            x="0"
            y="-70"
            textAnchor="middle"
            dominantBaseline="central"
            className={ui.pipelineBottomOrnamentSign}
          >
            PIPELINE VI
          </text>
        </g>
      </svg>
    </div>
  )
}
