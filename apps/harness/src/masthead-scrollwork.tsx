import { ui } from "./ui.js"

/** Decorative forged-iron field behind the masthead content. */
export function MastheadScrollwork() {
  return (
    <>
      <span className={ui.mastScrollworkGrain} aria-hidden="true" />
      <span className={ui.mastScrollworkVignette} aria-hidden="true" />
      <svg
        className={ui.mastScrollworkOrnament}
        aria-hidden="true"
        viewBox="0 0 1440 160"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <clipPath id="masthead-scrollwork-left-third">
            <rect width="455" height="160" />
          </clipPath>
          <g id="masthead-scrollwork-rails">
            <path d="M455 80H1465" />
            <path d="M480 80C525 80 530 34 575 34c35 0 49 34 29 50-23 18-55-2-43-25 7-14 27-14 33 1" />
            <path d="M480 80c45 0 50 46 95 46 35 0 49-34 29-50-23-18-55 2-43 25 7 14 27 14 33-1" />
            <path d="M705 80c45 0 50-46 95-46 35 0 49 34 29 50-23 18-55-2-43-25 7-14 27-14 33 1" />
            <path d="M705 80c45 0 50 46 95 46 35 0 49-34 29-50-23-18-55 2-43 25 7 14 27 14 33-1" />
            <path d="M930 80c45 0 50-46 95-46 35 0 49 34 29 50-23 18-55-2-43-25 7-14 27-14 33 1" />
            <path d="M930 80c45 0 50 46 95 46 35 0 49-34 29-50-23-18-55 2-43 25 7 14 27 14 33-1" />
            <path d="M1155 80c45 0 50-46 95-46 35 0 49 34 29 50-23 18-55-2-43-25 7-14 27-14 33 1" />
            <path d="M1155 80c45 0 50 46 95 46 35 0 49-34 29-50-23-18-55 2-43 25 7 14 27 14 33-1" />
            <path d="M675 145V31m-11 10 11-24 11 24M663 80l12-12 12 12-12 12Z" />
            <path d="M900 145V31m-11 10 11-24 11 24M888 80l12-12 12 12-12 12Z" />
            <path d="M1125 145V31m-11 10 11-24 11 24m-12 39 12-12 12 12-12 12Z" />
            <path d="M1350 145V31m-11 10 11-24 11 24m-12 39 12-12 12 12-12 12Z" />
          </g>
        </defs>
        <g clipPath="url(#masthead-scrollwork-left-third)">
          <g transform="translate(-450 0)">
            <use
              className={ui.mastScrollworkShadow}
              href="#masthead-scrollwork-rails"
            />
            <use
              className={ui.mastScrollworkBody}
              href="#masthead-scrollwork-rails"
            />
            <use
              className={ui.mastScrollworkHighlight}
              href="#masthead-scrollwork-rails"
            />
          </g>
        </g>
        <use
          className={ui.mastScrollworkShadow}
          href="#masthead-scrollwork-rails"
        />
        <use
          className={ui.mastScrollworkBody}
          href="#masthead-scrollwork-rails"
        />
        <use
          className={ui.mastScrollworkHighlight}
          href="#masthead-scrollwork-rails"
        />
      </svg>
    </>
  )
}
