import type { ButtonHTMLAttributes, ReactNode } from "react"
import { cx, ui } from "./ui.js"

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
  return (
    <div
      className={cx(
        ui.banner,
        tone === "guidance" ? ui.bannerGuidance : ui.bannerAlarm,
        className,
      )}
      role={role}
    >
      <span
        className={cx(
          ui.bannerTag,
          tone === "guidance" ? ui.bannerTagGuidance : ui.bannerTagAlarm,
        )}
      >
        {tag}
      </span>
      <div className={ui.bannerBody}>{children}</div>
      {action != null ? <div className={ui.bannerAction}>{action}</div> : null}
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
  return (
    <button type={type} className={cx(ui.plateMini, className)} {...props}>
      {children}
    </button>
  )
}
