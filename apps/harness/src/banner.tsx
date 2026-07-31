import type { ButtonHTMLAttributes, ReactNode } from "react"

/**
 * Interchange banner pattern (`docs/harness-design-system.md` §4.8).
 * One frame, two tones: alarm (Attention orange) and guidance (signal yellow).
 */
export type BannerTone = "alarm" | "guidance"

export function Banner({
  tone,
  tag,
  children,
  action,
  role = "status",
  className,
}: {
  tone: BannerTone
  tag: string
  children: ReactNode
  action?: ReactNode
  role?: "status" | "alert"
  className?: string
}) {
  const classes = [
    "banner",
    tone === "guidance" ? "banner--guidance" : "banner--alarm",
    className,
  ]
    .filter((part): part is string => part != null && part.length > 0)
    .join(" ")

  return (
    <div className={classes} role={role}>
      <span className="banner-tag">{tag}</span>
      <div className="banner-body">{children}</div>
      {action != null ? <div className="banner-action">{action}</div> : null}
    </div>
  )
}

/** Mini stamped plate used as the banner CTA (Open Settings, Retry, …). */
export function BannerActionButton({
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ["plate-mini", className]
    .filter((part): part is string => part != null && part.length > 0)
    .join(" ")
  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  )
}
