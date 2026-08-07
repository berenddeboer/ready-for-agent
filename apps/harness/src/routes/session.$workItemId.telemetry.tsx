/**
 * `/session/<work-item-id>/telemetry` — browser-addressable Session Telemetry
 * overlay (issues #841 / #843 / ADR 0048).
 *
 * The dialog lives in root chrome; this route supplies the canonical Pipeline
 * background for direct navigation and refresh. Explicit opens from Pipeline,
 * Repos, and Completed also land here so the URL and history entry stay
 * consistent; Close uses history.back when the open was in-app.
 */
import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "../pipeline-page.js"

export const Route = createFileRoute("/session/$workItemId/telemetry")({
  component: PipelinePage,
})
