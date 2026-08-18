/**
 * Session usage modal (Session Telemetry presentation).
 *
 * Open ownership is route-driven from root
 * (`/session/<work-item-id>/telemetry`, issues #841 / #843). Pipeline, Repos,
 * and Completed open the same path; this component only presents state.
 */
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
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
        agentTurnTailSupported: true,
      },
    })
    return result.session
  },
})

const agentTurnTailQuery = (workItemId: string) => ({
  queryKey: ["agentTurnTail", workItemId] as const,
  queryFn: async () => {
    const result = await graphql.query({
      agentTurnTail: {
        __args: { workItemId },
        availability: true,
        backend: { id: true, label: true },
        jumpHint: true,
        items: {
          __typename: true,
          on_AgentTurnTailAssistantText: {
            at: true,
            text: true,
            truncated: true,
          },
          on_AgentTurnTailTool: {
            at: true,
            name: true,
            status: true,
          },
        },
      },
    })
    return result.agentTurnTail
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
  const [tailOpen, setTailOpen] = useState(false)
  const session = useQuery({
    ...sessionQuery(workItemId ?? ""),
    enabled,
  })
  const tail = useQuery({
    ...agentTurnTailQuery(workItemId ?? ""),
    enabled: enabled && tailOpen,
  })

  useEffect(() => {
    if (!open) {
      setTailOpen(false)
    }
  }, [open])

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
  const showTailAction =
    showSessionId && session.data?.agentTurnTailSupported === true

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
        {tailOpen ? (
          <AgentTurnTailPanel
            isPending={tail.isPending}
            isError={tail.isError}
            data={tail.data}
          />
        ) : null}
      </div>
      <div
        className={cx(
          ui.dialogFooter,
          ui.dialogFooterCompact,
          showTailAction && "justify-between",
        )}
      >
        {showTailAction ? (
          <button
            type="button"
            className={ui.plateMini}
            onClick={() => {
              if (tailOpen) {
                void tail.refetch()
                return
              }
              setTailOpen(true)
            }}
          >
            {tailOpen ? "Refresh" : "Show tail"}
          </button>
        ) : null}
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

function AgentTurnTailPanel({
  isPending,
  isError,
  data,
}: {
  readonly isPending: boolean
  readonly isError: boolean
  readonly data:
    | Awaited<ReturnType<ReturnType<typeof agentTurnTailQuery>["queryFn"]>>
    | undefined
}) {
  if (isPending) {
    return <p className={ui.dialogLoading}>Loading tail…</p>
  }
  if (isError) {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="alarm"
        tag="Error"
        role="alert"
      >
        Could not load Agent Turn Tail. Try Refresh.
      </Banner>
    )
  }
  if (data === null || data === undefined) {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="guidance"
        tag="Session"
        role="status"
      >
        Work Item not found.
      </Banner>
    )
  }
  if (data.availability === "UNSUPPORTED") {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="guidance"
        tag="Session"
        role="status"
      >
        {data.backend.label} cannot serve a bounded Agent Turn Tail.
      </Banner>
    )
  }
  if (data.availability === "MISSING") {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="guidance"
        tag="Session"
        role="status"
      >
        {data.backend.label} no longer has this Session locally. Tail cannot be
        loaded.
      </Banner>
    )
  }
  if (data.availability === "UNAVAILABLE") {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="guidance"
        tag="Session"
        role="status"
      >
        {data.backend.label} Agent Turn Tail is temporarily unavailable.
      </Banner>
    )
  }
  if (data.jumpHint || data.items.length === 0) {
    return (
      <Banner
        className={ui.bannerCompact}
        tone="guidance"
        tag="Session"
        role="status"
      >
        No recent activity on this Session. Child Sessions are not shown. Use
        Jump.
      </Banner>
    )
  }
  return (
    <ol className="m-0 grid max-h-64 list-none gap-2 overflow-y-auto p-0">
      {data.items.map((item) => (
        <li
          key={`${item.__typename}-${item.at}-${item.__typename === "AgentTurnTailTool" ? item.name : item.text}`}
          className="border border-line-ghost px-3 py-2"
        >
          <p className="m-0 font-mono text-[0.62rem] tracking-[0.08em] text-ink-faint uppercase">
            {formatSessionInstant(item.at)}
          </p>
          {item.__typename === "AgentTurnTailTool" ? (
            <p className="mt-1 mb-0 font-mono text-xs text-ink">
              {item.name} ({item.status})
            </p>
          ) : (
            <p className="mt-1 mb-0 font-display text-sm text-ink">
              {item.text}
              {item.truncated ? "…" : ""}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}
