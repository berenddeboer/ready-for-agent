import { useState } from "react"
import { createHarnessGraphqlClient } from "./harness-graphql.js"
import {
  OPENCODE_SESSION_POPUP_BLOCKED,
  launchOpenCodeSessionWindow,
} from "./open-opencode-session.js"
import { cx } from "./ui.js"

const graphql = createHarnessGraphqlClient()

/**
 * Dialog action that opens the captured OpenCode Session. The click mints a
 * one-time connection; the button itself has no credential and no pairing URL.
 */
export function OpenInOpenCodeButton({
  workItemId,
  className,
  onUnavailable,
}: {
  readonly workItemId: string
  readonly className?: string
  readonly onUnavailable: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      className={cx(className)}
      disabled={pending}
      onClick={() => {
        if (pending) return
        setPending(true)
        onUnavailable("")
        void launchOpenCodeSessionWindow({
          openBlank: () => window.open("about:blank", "_blank"),
          request: async () => {
            const result = await graphql.mutation({
              openOpenCodeSession: {
                __args: { workItemId },
                connectUrl: true,
                sessionUrl: true,
                unavailableReason: true,
              },
            })
            const launch = result.openOpenCodeSession
            if (
              launch.connectUrl !== null &&
              launch.connectUrl !== undefined &&
              launch.sessionUrl !== null &&
              launch.sessionUrl !== undefined
            ) {
              return {
                connectUrl: launch.connectUrl,
                sessionUrl: launch.sessionUrl,
              }
            }
            return {
              unavailableReason:
                launch.unavailableReason ??
                "OpenCode is not available for this Session. The window was not opened.",
            }
          },
        })
          .then((outcome) => {
            if (outcome.kind === "popup-blocked") {
              onUnavailable(OPENCODE_SESSION_POPUP_BLOCKED)
              return
            }
            if (outcome.kind === "unavailable") {
              onUnavailable(outcome.message)
            }
          })
          .catch(() => {
            onUnavailable(
              "Could not connect this browser to the OpenCode server for this Session. Try again.",
            )
          })
          .finally(() => {
            setPending(false)
          })
      }}
    >
      Open in OpenCode
    </button>
  )
}
