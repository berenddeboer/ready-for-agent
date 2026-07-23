import { useCallback, useEffect, useRef, useState } from "react"

export function Copy({
  value,
  className,
  textClassName,
  showValue = true,
}: {
  value: string
  className?: string
  textClassName?: string
  /** When false, only the copy control is shown (value still copied). */
  showValue?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current)
      }
    }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current)
      }
      resetTimer.current = setTimeout(() => {
        setCopied(false)
        resetTimer.current = null
      }, 1_500)
    } catch {
      setCopied(false)
    }
  }, [value])

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 ${className ?? ""}`}
    >
      {showValue ? (
        <span
          className={`min-w-0 truncate ${textClassName ?? ""}`}
          title={value}
        >
          {value}
        </span>
      ) : null}
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        onClick={() => {
          void handleCopy()
        }}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <svg
            aria-hidden="true"
            className="size-3.5 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
    </span>
  )
}
