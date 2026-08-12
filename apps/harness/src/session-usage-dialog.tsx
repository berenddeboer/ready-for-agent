/**
 * Session usage modal (Session Telemetry presentation).
 *
 * Open ownership is route-driven from root
 * (`/session/<work-item-id>/telemetry`, issues #841 / #843). Pipeline, Repos,
 * and Completed open the same path; this component only presents state.
 */
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useRef } from "react"
import { Banner } from "./banner.js"
import { createHarnessGraphqlClient } from "./harness-graphql.js"
import { cx, ui } from "./ui.js"

const graphql = createHarnessGraphqlClient()

const sessionQuery = (workItemId: string) => ({
  queryKey: ["session", workItemId] as const,
  queryFn: async () => {
    const result = await graphql.query({
      session: {
        __args: { workItemId },
        id: true,
        availability: true,
        backend: { id: true, label: true },
        model: {
          providerId: true,
          id: true,
          thinkingLevel: true,
        },
        tokens: {
          input: true,
          output: true,
          reasoning: true,
          cacheRead: true,
          cacheWrite: true,
        },
        cost: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return result.session
  },
})

const formatSessionCost = (cost: number): string =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost)

const formatSessionInstant = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === "") {
    return "—"
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms)
}

const formatTokenCount = (value: number): string =>
  new Intl.NumberFormat(undefined).format(value)

export function SessionUsageDialog({
  workItemId,
  sessionId,
  open,
  onClose,
}: {
  workItemId: string | null
  sessionId: string | null
  open: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // useId keeps the accessible title stable if more than one mount ever
  // coexists (tests, transitions). Root is the sole production owner.
  const titleId = `session-usage-title-${useId().replaceAll(":", "")}`
  const enabled = open && workItemId !== null
  const session = useQuery({
    ...sessionQuery(workItemId ?? ""),
    enabled,
  })

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  const backendLabel = session.data?.backend.label
  // Prefer the open-time hint (Pipeline click / history state); fall back to
  // the session query id so direct `/session/<work-item-id>/telemetry` loads
  // still show the backend-local Session ID when available (issue #841).
  const displaySessionId =
    sessionId !== null && sessionId.length > 0
      ? sessionId
      : (session.data?.id ?? null)
  const showSessionId = displaySessionId !== null && displaySessionId.length > 0

  return (
    <dialog
      ref={dialogRef}
      className={cx(ui.dialogPanel, ui.dialogPanelNarrow)}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <div className={cx(ui.dialogHeader, ui.dialogHeaderCompact)}>
        <p className={ui.dialogKicker}>Session usage</p>
        <h2 id={titleId} className={cx(ui.dialogTitle, ui.dialogTitleSm)}>
          {backendLabel ? `${backendLabel} Session` : "Session"}
        </h2>
        {showSessionId && (
          <p
            className="mt-1 truncate font-mono text-xs text-ink-faint"
            title={displaySessionId}
          >
            {displaySessionId}
          </p>
        )}
      </div>
      <div className={cx(ui.dialogBody, ui.dialogBodyCompact)}>
        {!enabled ? null : session.isPending ? (
          <p className={ui.dialogLoading}>Loading usage…</p>
        ) : session.isError ? (
          <Banner
            className={ui.bannerCompact}
            tone="alarm"
            tag="Error"
            role="alert"
          >
            Could not load Session usage. Close and try again.
          </Banner>
        ) : session.data === null || session.data === undefined ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            Work Item not found.
          </Banner>
        ) : session.data.availability === "UNSUPPORTED" ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            {session.data.backend.label} does not provide Session Telemetry.
          </Banner>
        ) : session.data.availability === "MISSING" ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            {session.data.backend.label} no longer has this Session locally.
            Usage cannot be loaded.
          </Banner>
        ) : session.data.availability === "UNAVAILABLE" ? (
          <div className="grid gap-3">
            <Banner
              className={ui.bannerCompact}
              tone="guidance"
              tag="Session"
              role="status"
            >
              {session.data.backend.label} Session Telemetry is temporarily
              unavailable. Retry in a moment.
            </Banner>
            <button
              type="button"
              className={cx(ui.plateMini, "justify-self-start")}
              onClick={() => {
                void session.refetch()
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <table className={ui.dialogTable}>
            <tbody>
              <tr>
                <th scope="row">Model</th>
                <td>
                  {session.data.model === null ||
                  session.data.model === undefined
                    ? "—"
                    : [
                        session.data.model.providerId,
                        session.data.model.id,
                        session.data.model.thinkingLevel,
                      ]
                        .filter(
                          (part) =>
                            part !== null && part !== undefined && part !== "",
                        )
                        .join(" / ")}
                </td>
              </tr>
              <tr>
                <th scope="row">Input tokens</th>
                <td>{formatTokenCount(session.data.tokens?.input ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Output tokens</th>
                <td>{formatTokenCount(session.data.tokens?.output ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Reasoning tokens</th>
                <td>{formatTokenCount(session.data.tokens?.reasoning ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Cache read</th>
                <td>{formatTokenCount(session.data.tokens?.cacheRead ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Cache write</th>
                <td>
                  {formatTokenCount(session.data.tokens?.cacheWrite ?? 0)}
                </td>
              </tr>
              <tr>
                <th scope="row">Cost</th>
                <td>
                  {session.data.cost === null || session.data.cost === undefined
                    ? "—"
                    : formatSessionCost(session.data.cost)}
                </td>
              </tr>
              <tr>
                <th scope="row">Created</th>
                <td>{formatSessionInstant(session.data.createdAt)}</td>
              </tr>
              <tr>
                <th scope="row">Updated</th>
                <td>{formatSessionInstant(session.data.updatedAt)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className={cx(ui.dialogFooter, ui.dialogFooterCompact)}>
        <button
          type="button"
          className={ui.plateMini}
          onClick={() => {
            dialogRef.current?.close()
          }}
        >
          Close
        </button>
      </div>
    </dialog>
  )
}
