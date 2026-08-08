/**
 * `/session/<work-item-id>/telemetry` — browser-addressable Session Telemetry
 * overlay (issues #841 / #843 / ADR 0048).
 *
 * The dialog lives in root chrome; this route supplies the canonical Pipeline
 * background for direct navigation and refresh. In-app opens retain their
 * runtime route and mask it with this public URL; Close uses history.back.
 */
import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "../pipeline-page.js"

export const Route = createFileRoute("/session/$workItemId/telemetry")({
  component: PipelinePage,
})
