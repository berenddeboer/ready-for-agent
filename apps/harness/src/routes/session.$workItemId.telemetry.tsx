/**
 * `/session/<work-item-id>/telemetry` — browser-addressable Session Telemetry
 * overlay (issue #841 / ADR 0048).
 *
 * The dialog lives in root chrome; this route supplies the canonical Pipeline
 * background for direct navigation and refresh. Explicit opens from Pipeline
 * also land here so the URL and history entry stay consistent.
 */
import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "./index.js"

export const Route = createFileRoute("/session/$workItemId/telemetry")({
  component: PipelinePage,
})
